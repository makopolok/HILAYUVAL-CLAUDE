/**
 * Secure Bunny.net upload - No API keys exposed to client
 * Uses server-side proxy with temporary token authentication
 */
class SecureUploader {
  constructor(options = {}) {
    this.options = {
      onProgress: null,
      onComplete: null,
      onError: null,
      ...options
    };
    console.log('SecureUploader initialized with options:', options);
  }

  async uploadVideo(file, title) {
    const { onProgress, onComplete, onError } = this.options;
    
    try {
      console.log('Starting secure upload process for file:', file.name, 'size:', file.size);
      
      // Step 1: Get a secure upload session from our server
      console.log('Requesting secure upload session from server...');
      const sessionResponse = await fetch('/api/secure-upload/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: title || file.name || `Upload_${Date.now()}`
        })
      });
      
      console.log('Session response status:', sessionResponse.status);
      
      if (!sessionResponse.ok) {
        const error = await sessionResponse.json();
        console.error('Failed to create upload session:', error);
        throw new Error(error.message || 'Failed to create upload session');
      }
      
      const uploadSession = await sessionResponse.json();
      console.log('Created upload session:', uploadSession);
      
      // Step 2: Upload the file through our secure proxy
      console.log('Starting file upload to', uploadSession.uploadUrl);
      const xhr = new XMLHttpRequest();
      
      // Handle progress events
      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round((event.loaded / event.total) * 100);
            console.log(`Upload progress: ${percentComplete}%`);
            onProgress(percentComplete, uploadSession);
          }
        };
      }
      
      // Handle response
      xhr.onload = async () => {
        console.log('Upload request completed with status:', xhr.status);
        console.log('Response:', xhr.responseText);
        
        if (xhr.status >= 200 && xhr.status < 300) {
          console.log('Upload completed successfully');
          
          // Start polling for video processing status
          console.log('Starting processing status polling for video:', uploadSession.guid);
          this._pollProcessingStatus(uploadSession.guid, onComplete);
        } else {
          const errorMessage = `Upload failed with status ${xhr.status}`;
          console.error(errorMessage);
          if (onError) onError(new Error(errorMessage));
        }
      };
      
      // Handle errors
      xhr.onerror = (error) => {
        const errorMessage = 'Network error during upload';
        console.error(errorMessage, error);
        if (onError) onError(new Error(errorMessage));
      };
      
      // Send the file to our secure proxy endpoint
      xhr.open('PUT', uploadSession.uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Upload-Token', uploadSession.uploadToken);
      
      console.log('Sending file to secure proxy with token:', uploadSession.uploadToken);
      xhr.send(file);
      console.log('File upload request initiated');
      
      return uploadSession.guid;
    } catch (error) {
      console.error('Secure upload failed:', error);
      if (onError) onError(error);
      throw error;
    }
  }
  
  // Helper method to poll for processing status
  async _pollProcessingStatus(videoId, callback, maxAttempts = 60) {
    let attempts = 0;
    
    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/video/${videoId}/status`);
        if (!response.ok) {
          throw new Error('Failed to check video status');
        }
        
        const statusData = await response.json();
        console.log('Video status:', statusData);
        
        if (statusData.status === 'ready') {
          // Video is ready
          if (callback) callback(statusData);
          return;
        } else if (statusData.status === 'failed') {
          throw new Error('Video processing failed');
        }
        
        // Continue polling if not ready
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(checkStatus, 5000); // Check every 5 seconds
        } else {
          throw new Error('Timeout waiting for video processing');
        }
      } catch (error) {
        console.error('Status check error:', error);
        throw error;
      }
    };
    
    // Start polling
    setTimeout(checkStatus, 2000);
  }
}

// Helper function to create an uploader bound to form elements
function initSecureUploader(options) {
  const {
    fileInputId,
    progressElementId,
    statusElementId,
    videoIdInputId,
    formId,
    submitButtonId,
    titlePrefix = 'Upload'
  } = options;
  
  const fileInput = document.getElementById(fileInputId);
  const progressElement = document.getElementById(progressElementId);
  const statusElement = document.getElementById(statusElementId);
  const videoIdInput = document.getElementById(videoIdInputId);
  const form = document.getElementById(formId);
  const submitButton = document.getElementById(submitButtonId);
  
  if (!fileInput) {
    console.error(`File input with ID "${fileInputId}" not found`);
    return;
  }
  
  const uploader = new SecureUploader({
    onProgress: (percent) => {
      if (progressElement) {
        progressElement.style.width = `${percent}%`;
        progressElement.setAttribute('aria-valuenow', percent);
      }
      
      if (statusElement) {
        statusElement.textContent = `Uploading: ${percent}%`;
      }
    },
    onComplete: (videoData) => {
      if (statusElement) {
        statusElement.textContent = 'Video ready!';
      }
      
      if (progressElement) {
        progressElement.style.width = '100%';
      }
      
      if (videoIdInput && videoData.guid) {
        videoIdInput.value = videoData.guid;
      }
      
      if (submitButton) {
        submitButton.disabled = false;
      }
      
      console.log('Video upload and processing complete:', videoData);
    },
    onError: (error) => {
      if (statusElement) {
        statusElement.textContent = `Error: ${error.message}`;
      }
      
      console.error('Upload error:', error);
    }
  });
  
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    if (submitButton) {
      submitButton.disabled = true;
    }
    
    if (progressElement) {
      progressElement.style.width = '0%';
      progressElement.style.display = 'block';
    }
    
    if (statusElement) {
      statusElement.textContent = 'Initializing upload...';
    }
    
    try {
      const videoId = await uploader.uploadVideo(file, `${titlePrefix}_${Date.now()}`);
      
      if (videoIdInput) {
        videoIdInput.value = videoId;
      }
    } catch (error) {
      console.error('Upload initialization failed:', error);
      
      if (statusElement) {
        statusElement.textContent = `Error: ${error.message}`;
      }
      
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });
  
  // Prevent form submission until upload is complete
  if (form && submitButton) {
    form.addEventListener('submit', (event) => {
      if (!videoIdInput.value) {
        event.preventDefault();
        alert('Please wait for the video upload to complete before submitting.');
      }
    });
  }
  
  return uploader;
}

// Export to global scope for easy access
window.SecureUploader = SecureUploader;
window.initSecureUploader = initSecureUploader;
