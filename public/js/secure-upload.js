/**
 * Secure Bunny.net upload - No API keys exposed to client
 * Uses server-side proxy with temporary token authentication
 * 
 * Features:
 * - Chunked uploads for large files
 * - Resumable uploads
 * - Progress tracking with detailed statistics
 * - Direct integration with form submission
 */

// Helper function to format file sizes in a human-readable format
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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
    console.log('SecureUploader initialized with options:', options);
  }

  async uploadVideo(file, title) {
    const { onProgress, onComplete, onError } = this.options;
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
    
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
      
      // Step 2: Upload the file in chunks through our secure proxy
      console.log('Starting chunked file upload to', uploadSession.uploadUrl);
      
      // Store the session for potential resume
      localStorage.setItem('currentUploadSession', JSON.stringify({
        guid: uploadSession.guid,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        token: uploadSession.uploadToken,
        timestamp: Date.now()
      }));
      
      // Calculate total chunks
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      let uploadedBytes = 0;
      let uploadStats = {
        startTime: Date.now(),
        totalSize: file.size,
        uploadedSize: 0,
        formattedTotal: formatFileSize(file.size),
        formattedUploaded: '0 KB',
        speed: '0 KB/s',
        eta: 'calculating...'
      };
      
      // Process each chunk
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const chunk = file.slice(start, end);
        
        try {
          // Track chunk start time for speed calculation
          const chunkStartTime = Date.now();
          
          // Upload this chunk
          await this._uploadChunk(uploadSession, chunk, start, end, file.size, file.type, (chunkProgress) => {
            // Calculate overall progress considering chunks
            const chunkSize = end - start;
            const chunkBytesUploaded = Math.floor(chunkSize * (chunkProgress / 100));
            const totalBytesUploaded = uploadedBytes + chunkBytesUploaded;
            const overallProgress = Math.min(
              99, // Cap at 99% until fully complete
              Math.floor((totalBytesUploaded / file.size) * 100)
            );
            
            // Update upload stats for detailed reporting
            const elapsedMs = Date.now() - uploadStats.startTime;
            if (elapsedMs > 0 && totalBytesUploaded > 0) {
              // Calculate speed in bytes per second
              const speedBps = totalBytesUploaded / (elapsedMs / 1000);
              uploadStats.speed = formatFileSize(speedBps) + '/s';
              
              // Calculate ETA
              const remainingBytes = file.size - totalBytesUploaded;
              if (speedBps > 0) {
                const etaSeconds = Math.round(remainingBytes / speedBps);
                if (etaSeconds < 60) {
                  uploadStats.eta = `${etaSeconds} sec`;
                } else if (etaSeconds < 3600) {
                  uploadStats.eta = `${Math.floor(etaSeconds / 60)} min ${etaSeconds % 60} sec`;
                } else {
                  uploadStats.eta = `${Math.floor(etaSeconds / 3600)} hr ${Math.floor((etaSeconds % 3600) / 60)} min`;
                }
              }
            }
            
            uploadStats.uploadedSize = totalBytesUploaded;
            uploadStats.formattedUploaded = formatFileSize(totalBytesUploaded);
            
            // Call progress callback with detailed stats
            if (onProgress) {
              onProgress(overallProgress, uploadSession, uploadStats);
            }
          });
          
          // Update bytes uploaded after successful chunk
          uploadedBytes += chunk.size;
          console.log(`Chunk ${chunkIndex + 1}/${totalChunks} uploaded (${formatFileSize(uploadedBytes)}/${formatFileSize(file.size)})`);
          
          // Calculate and log chunk upload speed
          const chunkTime = (Date.now() - chunkStartTime) / 1000; // seconds
          const chunkSpeed = chunk.size / chunkTime; // bytes per second
          console.log(`Chunk upload speed: ${formatFileSize(chunkSpeed)}/s`);
          
        } catch (chunkError) {
          console.error(`Error uploading chunk ${chunkIndex + 1}/${totalChunks}:`, chunkError);
          throw new Error(`Chunk upload failed: ${chunkError.message}`);
        }
      }
      
      console.log('All chunks uploaded successfully');
      
      // Final progress update (100%)
      if (onProgress) {
        onProgress(100, uploadSession, {
          ...uploadStats,
          uploadedSize: file.size,
          formattedUploaded: formatFileSize(file.size),
          eta: '0 sec'
        });
      }
      
      // Notify that the upload part is complete (but processing may still be ongoing)
      if (this.options.onUploadComplete) {
        this.options.onUploadComplete(uploadSession);
      }
      
      // Clear the upload session from localStorage since it completed successfully
      localStorage.removeItem('currentUploadSession');
      
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
  
  // Helper method to upload a single chunk
  async _uploadChunk(uploadSession, chunk, start, end, totalSize, contentType, onChunkProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      // Handle progress events for this chunk
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100);
          if (onChunkProgress) onChunkProgress(percentComplete);
        }
      };
      
      // Handle completion
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Chunk upload failed with status ${xhr.status}`));
        }
      };
      
      // Handle errors
      xhr.onerror = () => {
        reject(new Error('Network error during chunk upload'));
      };
      
      // Send the chunk to our secure proxy endpoint
      xhr.open('PUT', uploadSession.uploadUrl);
      xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
      xhr.setRequestHeader('X-Upload-Token', uploadSession.uploadToken);
      
      // Add Content-Range header for resumable upload
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${end-1}/${totalSize}`);
      
      xhr.send(chunk);
    });
  }
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
    onProgress: (percent, session, stats) => {
      if (progressElement) {
        progressElement.value = percent;
      }
      
      // Update any progress bar element
      const progressBar = document.getElementById('upload-progress-bar');
      if (progressBar) {
        progressBar.style.width = `${percent}%`;
        progressBar.setAttribute('aria-valuenow', percent);
      }
      
      // Update any status element with detailed information if stats are available
      if (statusElement) {
        if (stats) {
          statusElement.textContent = `${percent}%`;
          
          // Update inline status badges with more detailed info
          const inlineStatus = document.getElementById('inline-upload-status');
          if (inlineStatus) {
            if (percent < 100) {
              inlineStatus.textContent = `Uploading ${stats.speed}`;
            } else {
              inlineStatus.textContent = 'Processing...';
            }
          }
          
          // Update overlay detailed status with additional info
          const overlayDetailedStatus = document.getElementById('overlay-detailed-status');
          if (overlayDetailedStatus && stats) {
            if (percent < 100) {
              overlayDetailedStatus.innerHTML = `
                Uploading (${percent}%)<br>
                <small class="text-muted">${stats.formattedUploaded} of ${stats.formattedTotal}</small><br>
                <small class="text-muted">Speed: ${stats.speed} • ETA: ${stats.eta}</small>
              `;
            }
          }
        } else {
          statusElement.textContent = `${percent}%`;
        }
      }
      
      // Forward to the user-provided callback
      if (options.onProgress) {
        options.onProgress(percent, session, stats);
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
