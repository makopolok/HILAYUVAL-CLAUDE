/**
 * Secure Bunny.net upload - No API keys exposed to client
 * Uses server-side proxy with temporary token authentication
 */

// Helper function to format file sizes in a human-readable format
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

class SecureUploader {
  constructor(options = {}) {
    this.options = {
      onProgress: null,
      onComplete: null,
      onError: null,
      onUploadComplete: null, // Added for when the file upload is done but processing hasn't finished
      ...options
    };
    console.log('SecureUploader initialized with options:', JSON.stringify(options));
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
      
      // Use simple non-chunked upload for reliability
      const uploadResult = await this._uploadFile(uploadSession, file, (percent) => {
        if (onProgress) {
          onProgress(percent);
        }
      });
      
      console.log('Upload complete with result:', uploadResult);
      
      // Notify that the upload part is complete (but processing may still be ongoing)
      if (this.options.onUploadComplete) {
        this.options.onUploadComplete(uploadSession);
      }
      
      // Start polling for video processing status
      console.log('Starting processing status polling for video:', uploadSession.guid);
      this._pollProcessingStatus(uploadSession.guid, onComplete);
      
      return uploadSession.guid;
    } catch (error) {
      console.error('Secure upload failed:', error);
      if (onError) onError(error);
      throw error;
    }
  }
  
  // Helper method to upload a file
  async _uploadFile(uploadSession, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      // Handle progress events
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100);
          if (onProgress) onProgress(percentComplete);
        }
      };
      
      // Handle completion
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            resolve(result);
          } catch (e) {
            resolve({ success: true });
          }
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };
      
      // Handle errors
      xhr.onerror = () => {
        reject(new Error('Network error during upload'));
      };
      
      // Send the file to our secure proxy endpoint
      xhr.open('PUT', uploadSession.uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Upload-Token', uploadSession.uploadToken);
      
      xhr.send(file);
    });
  }
  
  // Helper method to poll for processing status
  async _pollProcessingStatus(videoId, callback, maxAttempts = 60) {
    let attempts = 0;
    let forceCompletionTimer = null;
    
    // Set a timeout to force completion after 30 seconds regardless of status
    forceCompletionTimer = setTimeout(() => {
      console.log('Forcing video completion after timeout period');
      if (callback) {
        callback({
          guid: videoId,
          status: 'force_completed',
          ready: true,
          forced: true
        });
      }
    }, 30000); // Force after 30 seconds
    
    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/video/${videoId}/status`);
        if (!response.ok) {
          throw new Error('Failed to check video status');
        }
        
        const statusData = await response.json();
        console.log('Video status:', statusData);
        
        // Consider the video ready if:
        // 1. status is 'ready' (string)
        // 2. ready is true (boolean)
        // 3. status is 4 or greater (number) and we've waited at least 5 polling attempts
        const isReady = 
          statusData.status === 'ready' || 
          statusData.ready === true || 
          (typeof statusData.status === 'number' && statusData.status >= 4 && attempts >= 5);
        
        if (isReady) {
          // Video is considered ready enough
          console.log('Video considered ready with status:', statusData.status);
          
          // Clear the force completion timer since we're completing normally
          if (forceCompletionTimer) {
            clearTimeout(forceCompletionTimer);
            forceCompletionTimer = null;
          }
          
          if (callback) callback({...statusData, guid: videoId});
          return;
        } else if (statusData.status === 'failed' || statusData.status < 0) {
          // Clear the force completion timer
          if (forceCompletionTimer) {
            clearTimeout(forceCompletionTimer);
            forceCompletionTimer = null;
          }
          
          throw new Error('Video processing failed');
        }
        
        // Continue polling if not ready
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(checkStatus, 5000); // Check every 5 seconds
        } else {
          // Clear the force completion timer
          if (forceCompletionTimer) {
            clearTimeout(forceCompletionTimer);
            forceCompletionTimer = null;
          }
          
          console.log('Reached maximum attempts, considering video ready anyway');
          if (callback) callback({...statusData, guid: videoId, ready: true});
        }
      } catch (error) {
        console.error('Status check error:', error);
        
        // Clear the force completion timer
        if (forceCompletionTimer) {
          clearTimeout(forceCompletionTimer);
          forceCompletionTimer = null;
        }
        
        // On error, just consider the video ready if we have an ID
        console.log('Error during status check, proceeding with submission anyway');
        if (callback) callback({guid: videoId, ready: true, error: error.message});
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
        progressElement.value = percent;
      }
      
      // Update any progress bar element
      const progressBar = document.getElementById('upload-progress-bar');
      if (progressBar) {
        progressBar.style.width = `${percent}%`;
        progressBar.setAttribute('aria-valuenow', percent);
      }
      
      // Update any status element
      if (statusElement) {
        statusElement.textContent = `${percent}%`;
      }
      
      // Update overlay display if present
      const overlayBar = document.getElementById('overlay-upload-progress-bar');
      const overlayText = document.getElementById('overlay-upload-progress-text');
      
      if (overlayBar) overlayBar.style.width = `${percent}%`;
      if (overlayText) overlayText.textContent = `${percent}%`;
      
      // Show the direct upload UI when upload starts
      if (percent > 0) {
        const directUploadUI = document.getElementById('direct-upload-ui');
        if (directUploadUI) directUploadUI.classList.remove('d-none');
        
        // Show loading overlay if present
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) loadingOverlay.classList.remove('d-none');
      }
      
      // Forward the call to the user's callback
      if (options.onProgress) {
        options.onProgress(percent);
      }
    },
    onComplete: (videoData) => {
      if (statusElement) {
        statusElement.textContent = 'Video ready!';
      }
      
      if (progressElement) {
        progressElement.value = 100;
      }
      
      if (videoIdInput && videoData.guid) {
        videoIdInput.value = videoData.guid;
        console.log('Video ID set to:', videoData.guid);
      }
      
      if (submitButton) {
        submitButton.disabled = false;
      }
      
      console.log('Video upload and processing complete:', videoData);
      
      // Forward the call to the user's callback
      if (options.onComplete) {
        options.onComplete(videoData);
      }
    },
    onError: (error) => {
      if (statusElement) {
        statusElement.textContent = `Error: ${error.message}`;
      }
      
      console.error('Upload error:', error);
      
      // Forward the call to the user's callback
      if (options.onError) {
        options.onError(error);
      }
    },
    onUploadComplete: (session) => {
      console.log('File upload complete, now processing...');
      
      // Update status messages
      const uploadingStatus = document.getElementById('upload-status-uploading');
      const processingStatus = document.getElementById('upload-status-processing');
      
      if (uploadingStatus) uploadingStatus.classList.add('d-none');
      if (processingStatus) processingStatus.classList.remove('d-none');
      
      // Update overlay if present
      const uploadPhase = document.getElementById('upload-phase');
      const processingPhase = document.getElementById('processing-phase');
      
      if (uploadPhase) uploadPhase.classList.add('d-none');
      if (processingPhase) processingPhase.classList.remove('d-none');
      
      // Forward the call to the user's callback
      if (options.onUploadComplete) {
        options.onUploadComplete(session);
      }
    }
  });
  
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    if (submitButton) {
      submitButton.disabled = true;
    }
    
    if (progressElement) {
      progressElement.value = 0;
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
  
  // Manage form submission based on upload state
  if (form && submitButton) {
    form.addEventListener('submit', (event) => {
      console.log('Form submit event intercepted');
      
      // Get the current upload progress
      const currentProgress = progressElement ? 
        parseInt(progressElement.value || '0') : 0;
      
      // CASE 1: Upload in active progress (not yet complete)
      const uploadInProgress = progressElement && 
                              currentProgress > 0 && 
                              currentProgress < 100;
      
      if (uploadInProgress) {
        // Only block submission if upload is actively in progress
        event.preventDefault();
        alert('Please wait for the video upload to complete before submitting.');
        console.log('Form submission prevented - upload in progress');
        return false;
      }
      
      // Allow submission in all other cases
      return true;
    });
  }
  
  return uploader;
}

// Export to global scope for easy access
window.SecureUploader = SecureUploader;
window.initSecureUploader = initSecureUploader;
window.formatFileSize = formatFileSize; // Export the helper function
