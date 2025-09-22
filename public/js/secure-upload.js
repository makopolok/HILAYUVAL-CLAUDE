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
        console.log('Video ID set to:', videoData.guid);
      }
      
      if (submitButton) {
        submitButton.disabled = false;
      }
      
      console.log('Video upload and processing complete:', videoData);
      
      // Use a timeout to ensure the videoId is properly set before submitting
      setTimeout(() => {
        if (form && videoIdInput && videoIdInput.value) {
          console.log('Auto-submitting form after successful video upload with delay');
          
          // Create and dispatch a submit event to trigger any attached handlers
          const submitEvent = new Event('submit', {
            bubbles: true,
            cancelable: true
          });
          
          // Dispatch the event first to run any handlers
          const eventResult = form.dispatchEvent(submitEvent);
          
          // If the event wasn't prevented, submit the form directly
          if (eventResult) {
            console.log('Submit event not prevented, submitting form directly');
            form.submit();
          } else {
            console.log('Submit event was prevented, not submitting form');
            // If prevented, we should show a message or enable manual submission
            if (statusElement) {
              statusElement.textContent = 'Video ready! Click Submit to continue.';
            }
          }
        }
      }, 1000); // Wait 1 second to ensure everything is ready
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
  
  // Only prevent form submission if upload is in progress
  if (form && submitButton) {
    form.addEventListener('submit', (event) => {
      // If video upload is in progress (not completed) and we don't have a video ID yet
      const uploadInProgress = progressElement && 
                              parseInt(progressElement.style.width || '0') > 0 && 
                              parseInt(progressElement.style.width || '0') < 100;
      
      if (uploadInProgress && !videoIdInput.value) {
        event.preventDefault();
        alert('Please wait for the video upload to complete before submitting.');
        return false;
      } else {
        console.log('Form submission allowed - either no upload in progress or upload completed');
        console.log('Video ID at submission time:', videoIdInput ? videoIdInput.value : 'no input element');
        
        // Force set form submit button to enabled state to ensure submission works
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.removeAttribute('disabled');
        }
        
        // Show submit spinner to indicate form is being submitted
        const submitText = document.getElementById('submit-text');
        const submitSpinner = document.getElementById('submit-spinner');
        
        if (submitText && submitSpinner) {
          submitText.classList.add('d-none');
          submitSpinner.classList.remove('d-none');
        }
        
        return true;
      }
    });
  }
  
  return uploader;
}

// Export to global scope for easy access
window.SecureUploader = SecureUploader;
window.initSecureUploader = initSecureUploader;
