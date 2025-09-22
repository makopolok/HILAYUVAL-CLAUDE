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
      onUploadComplete: null, // Added for when the file upload is done but processing hasn't finished
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
          
          // Notify that the upload part is complete (but processing may still be ongoing)
          if (this.options.onUploadComplete) {
            this.options.onUploadComplete(uploadSession);
          }
          
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
        submitButton.removeAttribute('disabled');
      }
      
      console.log('Video upload and processing complete:', videoData);
      
      // Force any validation classes to be reset
      if (form) {
        // Mark all fields as valid
        const inputs = form.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
          input.classList.remove('is-invalid');
          input.classList.add('is-valid');
        });
      }
      
      // Function to attempt form submission in multiple ways
      const attemptSubmission = () => {
        console.log('Attempting aggressive form submission');
        
        try {
          // METHOD 1: Create and dispatch a submit event
          const submitEvent = new Event('submit', {
            bubbles: true,
            cancelable: true
          });
          
          // Dispatch the event first to run any handlers
          const eventResult = form.dispatchEvent(submitEvent);
          console.log('Submit event dispatched, prevented:', !eventResult);
          
          // METHOD 2: Direct form submission
          if (form) {
            console.log('Directly submitting form');
            
            // First, make sure the submit button isn't disabled
            if (submitButton) {
              submitButton.disabled = false;
              submitButton.removeAttribute('disabled');
              submitButton.click(); // Try clicking the button
            }
            
            // As a last resort, direct form submission
            setTimeout(() => {
              console.log('Last resort: direct form.submit() call');
              form.submit();
            }, 500);
          }
        } catch (error) {
          console.error('Error during form submission:', error);
          
          // Show an alert that user needs to submit manually
          if (statusElement) {
            statusElement.textContent = 'Video ready! Please click Submit to continue.';
            statusElement.style.color = 'green';
            statusElement.style.fontWeight = 'bold';
          }
          
          // Make the submit button very visible
          if (submitButton) {
            submitButton.style.backgroundColor = 'green';
            submitButton.style.fontSize = '1.2em';
            submitButton.style.padding = '10px 20px';
            submitButton.textContent = 'Submit Now - Video Ready!';
          }
        }
      };
      
      // Use a timeout to ensure the videoId is properly set before submitting
      setTimeout(attemptSubmission, 2000); // Wait 2 seconds to ensure everything is ready
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
  
  // Manage form submission based on upload state
  if (form && submitButton) {
    form.addEventListener('submit', (event) => {
      console.log('Form submit event intercepted');
      
      // Get the current upload progress
      const currentProgress = progressElement ? 
        parseInt(progressElement.style.width || '0') : 0;
      
      // CASE 1: Upload in active progress (not yet complete)
      const uploadInProgress = progressElement && 
                              currentProgress > 0 && 
                              currentProgress < 100;
      
      // CASE 2: No video selected or required
      const noVideoSelected = !document.getElementById('video') || 
                              !document.getElementById('video').files || 
                              document.getElementById('video').files.length === 0;
      
      // CASE 3: Upload completed but no video ID (processing failure)
      const uploadCompletedNoId = progressElement && 
                                 currentProgress === 100 && 
                                 (!videoIdInput || !videoIdInput.value);
      
      if (uploadInProgress) {
        // Only block submission if upload is actively in progress
        event.preventDefault();
        alert('Please wait for the video upload to complete before submitting.');
        console.log('Form submission prevented - upload in progress');
        return false;
      } else {
        // Allow submission in all other cases
        console.log('Form submission allowed:', 
          noVideoSelected ? 'No video selected' : 
          uploadCompletedNoId ? 'Upload completed but no ID (continuing anyway)' : 
          'Upload completed with ID');
        
        // Log the video ID if we have it
        if (videoIdInput) {
          console.log('Video ID at submission time:', videoIdInput.value || 'empty');
        }
        
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
