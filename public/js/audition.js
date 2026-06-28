(function () {
  const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
  const MAX_PROFILE_PICTURES = 10;

  const VIDEO_TYPES = [
    'video/mp4', 'video/avi', 'video/mov', 'video/wmv',
    'video/flv', 'video/webm', 'video/mkv', 'video/quicktime'
  ];
  const IMAGE_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg'
  ];

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function validateFileSize(file) {
    return file.size <= MAX_FILE_SIZE;
  }

  function validateVideoType(file) {
    return VIDEO_TYPES.includes(file.type);
  }

  function validateImageType(file) {
    return IMAGE_TYPES.includes(file.type);
  }

  function showFileError(fieldName, message) {
    const field = document.getElementById(fieldName);
    if (!field || !field.parentNode) return;

    const existingError = field.parentNode.querySelector('.file-error');
    if (existingError) {
      existingError.remove();
    }

    const errorDiv = document.createElement('div');
    errorDiv.className = 'file-error alert alert-danger mt-2 p-2';
    errorDiv.innerHTML = `<i class="fas fa-exclamation-triangle me-1"></i> ${message}`;

    field.parentNode.appendChild(errorDiv);
    field.classList.add('is-invalid');
  }

  function clearFileError(fieldName) {
    const field = document.getElementById(fieldName);
    if (!field || !field.parentNode) return;

    const existingError = field.parentNode.querySelector('.file-error');
    if (existingError) {
      existingError.remove();
    }

    field.classList.remove('is-invalid');
  }

  function handleVideoSelection(event) {
    const file = event.target.files[0];
    const preview = document.getElementById('video-preview');
    if (!preview) return;

    if (!file) {
      preview.classList.add('d-none');
      return;
    }

    if (!validateVideoType(file)) {
      showFileError('video', 'Please select a valid video file (MP4, MOV, AVI, WMV, FLV, WebM, MKV)');
      event.target.value = '';
      preview.classList.add('d-none');
      return;
    }

    if (!validateFileSize(file)) {
      showFileError('video', `Video file is too large (${formatFileSize(file.size)}). Maximum size is 500MB.`);
      event.target.value = '';
      preview.classList.add('d-none');
      return;
    }

    const videoName = document.getElementById('video-name');
    const videoSize = document.getElementById('video-size');
    const videoType = document.getElementById('video-type');
    if (videoName) videoName.textContent = file.name;
    if (videoSize) videoSize.textContent = formatFileSize(file.size);
    if (videoType) videoType.textContent = file.type;
    preview.classList.remove('d-none');
    clearFileError('video');
  }

  function handleProfilePicturesSelection(event) {
    const files = Array.from(event.target.files);
    const preview = document.getElementById('profile-pictures-preview');
    const list = document.getElementById('profile-pictures-list');
    if (!preview || !list) return;

    if (!files.length) {
      preview.classList.add('d-none');
      return;
    }

    if (files.length > MAX_PROFILE_PICTURES) {
      showFileError('profile_pictures', `Too many files selected. Maximum ${MAX_PROFILE_PICTURES} profile pictures allowed.`);
      event.target.value = '';
      preview.classList.add('d-none');
      return;
    }

    let hasErrors = false;
    const validFiles = [];

    files.forEach((file) => {
      if (!validateImageType(file)) {
        showFileError('profile_pictures', `File "${file.name}" is not a valid image type.`);
        hasErrors = true;
        return;
      }

      if (!validateFileSize(file)) {
        showFileError('profile_pictures', `File "${file.name}" is too large (${formatFileSize(file.size)}). Maximum size is 500MB.`);
        hasErrors = true;
        return;
      }

      validFiles.push(file);
    });

    if (hasErrors) {
      event.target.value = '';
      preview.classList.add('d-none');
      return;
    }

    list.innerHTML = '';
    validFiles.forEach((file) => {
      const col = document.createElement('div');
      col.className = 'col-6 col-md-4 col-lg-3';
      col.innerHTML = `
        <div class="card border-success">
          <div class="card-body p-2">
            <div class="d-flex align-items-center">
              <i class="fas fa-image text-success me-2"></i>
              <div class="flex-grow-1">
                <div class="small fw-bold text-truncate">${file.name}</div>
                <div class="small text-muted">${formatFileSize(file.size)}</div>
              </div>
            </div>
          </div>
        </div>
      `;
      list.appendChild(col);
    });

    preview.classList.remove('d-none');
    clearFileError('profile_pictures');
  }

  function getAuditionSuccessUrl(action) {
    return action.replace(/\/audition\/(\d+)$/, '/audition/$1/success');
  }

  function resetYoutubeUploadUi(state) {
    if (state.submitBtn) state.submitBtn.disabled = false;
    if (state.submitText) state.submitText.classList.remove('d-none');
    if (state.submitSpinner) state.submitSpinner.classList.add('d-none');
    if (state.overlay) state.overlay.classList.add('d-none');
    if (state.overlayProgressText) state.overlayProgressText.textContent = '0%';
    if (state.overlayProgressBar) state.overlayProgressBar.style.width = '0%';
  }

  function setYoutubeUploadUi(state, pct, text) {
    if (state.submitBtn) state.submitBtn.disabled = true;
    if (state.submitText) state.submitText.classList.add('d-none');
    if (state.submitSpinner) state.submitSpinner.classList.remove('d-none');
    if (state.overlay) state.overlay.classList.remove('d-none');
    if (state.overlayTitle) {
      state.overlayTitle.innerHTML = '<i class="fas fa-cloud-upload-alt me-2"></i>Uploading...';
    }
    if (state.overlayProgressText) state.overlayProgressText.textContent = text || `${pct || 0}%`;
    if (state.overlayProgressBar && typeof pct === 'number') {
      state.overlayProgressBar.style.width = `${pct}%`;
    }
  }

  function clearVideoSelection() {
    const videoInput = document.getElementById('video');
    const preview = document.getElementById('video-preview');
    if (videoInput) videoInput.value = '';
    if (preview) preview.classList.add('d-none');
    clearFileError('video');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('audition-form');
    const videoInput = document.getElementById('video');
    const profileInput = document.getElementById('profile_pictures');

    if (videoInput) {
      videoInput.addEventListener('change', handleVideoSelection);
    }

    if (profileInput) {
      profileInput.addEventListener('change', handleProfilePicturesSelection);
    }

    document.querySelectorAll('[data-clear-video]').forEach((button) => {
      button.addEventListener('click', clearVideoSelection);
    });

    if (!form) return;

    const method = (form.getAttribute('data-upload-method') || '').toLowerCase();
    if (method !== 'youtube') return;

    let youtubeSubmitInFlight = false;
    form.addEventListener('submit', function (event) {
      if (youtubeSubmitInFlight) {
        event.preventDefault();
        return;
      }

      if (!form.checkValidity()) {
        event.preventDefault();
        event.stopPropagation();
        form.classList.add('was-validated');
        return;
      }

      event.preventDefault();
      youtubeSubmitInFlight = true;

      const uploadUi = {
        submitBtn: document.getElementById('submit-btn'),
        submitText: document.getElementById('submit-text'),
        submitSpinner: document.getElementById('submit-spinner'),
        overlay: document.getElementById('loading-overlay'),
        overlayTitle: document.querySelector('#loading-overlay h4'),
        overlayProgressText: document.getElementById('overlay-upload-progress-text'),
        overlayProgressBar: document.getElementById('overlay-upload-progress-bar'),
      };

      setYoutubeUploadUi(uploadUi, 0, '0%');

      try {
        const formData = new FormData(form);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', form.action, true);
        xhr.withCredentials = true;
        xhr.responseType = 'text';
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const pct = Math.max(1, Math.min(99, Math.round((e.loaded / e.total) * 100)));
          setYoutubeUploadUi(uploadUi, pct, `${pct}%`);
        };
        xhr.onerror = () => {
          youtubeSubmitInFlight = false;
          resetYoutubeUploadUi(uploadUi);
        };
        xhr.onload = () => {
          // Check if server returned a background job (YouTube upload)
          if (xhr.status === 200 && xhr.responseText && xhr.responseText.includes('"jobId"')) {
            try {
              const data = JSON.parse(xhr.responseText);
              if (data.jobId) {
                // YouTube upload is running in the background — poll for completion
                setYoutubeUploadUi(uploadUi, 99, 'Processing on YouTube...');
                pollUploadJob(data.jobId, form.action, uploadUi, function() {
                  youtubeSubmitInFlight = false;
                });
                return;
              }
            } catch (e) { /* not JSON, fall through */ }
          }

          youtubeSubmitInFlight = false;
          if (xhr.status >= 200 && xhr.status < 400) {
            window.location.assign(getAuditionSuccessUrl(form.action));
            return;
          }
          // On error, check if response is HTML (error page) or JSON
          if (xhr.status >= 400) {
            console.error('Upload error - Status:', xhr.status);
            console.error('Response:', xhr.responseText?.substring(0, 500));
            
            // If response is HTML (error page), write it to the document
            if (xhr.responseText && (xhr.responseText.includes('<!DOCTYPE') || xhr.responseText.includes('<html'))) {
              // Server sent an error page - display it
              document.open();
              document.write(xhr.responseText);
              document.close();
              return;
            }
            
            // Otherwise, redirect to error page
            const projectId = form.action.split('/').filter(Boolean).pop();
            window.location.href = `/audition/${projectId || ''}/error`;
            return;
          }
          resetYoutubeUploadUi(uploadUi);
        };
        xhr.send(formData);
      } catch (err) {
        youtubeSubmitInFlight = false;
        resetYoutubeUploadUi(uploadUi);
        throw err;
      }
    });
  });

  function pollUploadJob(jobId, formAction, uploadUi, onDone) {
    fetch('/upload-status/' + jobId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.status === 'done') {
          onDone();
          window.location.assign(getAuditionSuccessUrl(formAction));
        } else if (data.status === 'error' || data.status === 'not_found') {
          onDone();
          const projectId = formAction.split('/').filter(Boolean).pop();
          window.location.href = '/audition/' + (projectId || '') + '/error';
        } else {
          // Still processing — poll again in 3 seconds
          setTimeout(function() { pollUploadJob(jobId, formAction, uploadUi, onDone); }, 3000);
        }
      })
      .catch(function() {
        // Network error while polling — retry
        setTimeout(function() { pollUploadJob(jobId, formAction, uploadUi, onDone); }, 5000);
      });
  }
})();
