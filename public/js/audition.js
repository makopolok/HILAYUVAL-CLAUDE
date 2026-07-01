(function () {
  const DEFAULT_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
  let maxVideoSizeBytes = DEFAULT_MAX_FILE_SIZE;
  let maxProfilePictureSizeBytes = DEFAULT_MAX_FILE_SIZE;
  let maxProfilePictures = 10;
  let requireProfilePicture = false;
  let maxVideoDurationSeconds = 0;

  const VIDEO_TYPES = [
    'video/mp4', 'video/avi', 'video/mov', 'video/wmv',
    'video/flv', 'video/webm', 'video/mkv', 'video/quicktime'
  ];
  const IMAGE_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg'
  ];
  const ROMAN_NAME_REGEX = /^[A-Za-z][A-Za-z\s.'-]*$/;
  const PHONE_ALLOWED_CHARS_REGEX = /^[0-9\-+() ]+$/;

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function validateFileSize(file, maxBytes) {
    return file.size <= maxBytes;
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

  function applyRomanNameConstraint(field) {
    if (!field) return;
    const value = (field.value || '').trim();
    if (!value) {
      field.setCustomValidity('');
      return;
    }
    field.setCustomValidity(ROMAN_NAME_REGEX.test(value) ? '' : 'Please use Roman letters only.');
  }

  function applyPhoneConstraint(field) {
    if (!field) return;
    const value = (field.value || '').trim();
    if (!value) {
      field.setCustomValidity('');
      return;
    }
    if (!PHONE_ALLOWED_CHARS_REGEX.test(value)) {
      field.setCustomValidity('Please enter a valid phone number.');
      return;
    }
    const digits = value.replace(/\D/g, '');
    field.setCustomValidity(digits.length >= 7 && digits.length <= 15 ? '' : 'Please enter a valid phone number.');
  }

  function updateFieldValidationState(field, forceShow) {
    if (!field) return true;

    if (field.id === 'first_name_en' || field.id === 'last_name_en') {
      applyRomanNameConstraint(field);
    }
    if (field.id === 'phone') {
      applyPhoneConstraint(field);
    }

    const value = (field.value || '').trim();
    const isOptionalEmpty = !field.required && value === '';
    const shouldShow = Boolean(forceShow || field.dataset.touched === '1' || value !== '');

    field.classList.remove('is-valid', 'is-invalid');

    if (isOptionalEmpty) {
      field.setCustomValidity('');
      return true;
    }

    const isValid = field.checkValidity();
    if (shouldShow) {
      field.classList.add(isValid ? 'is-valid' : 'is-invalid');
    }
    return isValid;
  }

  function bindRealtimeValidation(field) {
    if (!field) return;

    const handler = function () {
      field.dataset.touched = '1';
      updateFieldValidationState(field, true);
    };

    field.addEventListener('input', handler);
    field.addEventListener('change', handler);
    field.addEventListener('blur', handler);
  }

  function getVideoDuration(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onloadedmetadata = function () {
        const duration = probe.duration;
        URL.revokeObjectURL(objectUrl);
        resolve(duration);
      };
      probe.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Could not inspect the selected video.'));
      };
      probe.src = objectUrl;
    });
  }

  async function handleVideoSelection(event) {
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

    if (!validateFileSize(file, maxVideoSizeBytes)) {
      showFileError('video', `Video file is too large (${formatFileSize(file.size)}). Maximum size is ${formatFileSize(maxVideoSizeBytes)}.`);
      event.target.value = '';
      preview.classList.add('d-none');
      return;
    }

    if (maxVideoDurationSeconds > 0) {
      try {
        const duration = await getVideoDuration(file);
        if (duration > maxVideoDurationSeconds) {
          showFileError('video', `Please select a video that is ${Math.floor(maxVideoDurationSeconds / 60)} minutes or shorter.`);
          event.target.value = '';
          preview.classList.add('d-none');
          return;
        }
      } catch (error) {
        showFileError('video', error.message);
        event.target.value = '';
        preview.classList.add('d-none');
        return;
      }
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
      clearFileError('profile_pictures');
      return;
    }

    if (files.length > maxProfilePictures) {
      showFileError('profile_pictures', `Too many files selected. Maximum ${maxProfilePictures} profile picture${maxProfilePictures === 1 ? '' : 's'} allowed.`);
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

      if (!validateFileSize(file, maxProfilePictureSizeBytes)) {
        showFileError('profile_pictures', `File "${file.name}" is too large (${formatFileSize(file.size)}). Maximum size is ${formatFileSize(maxProfilePictureSizeBytes)}.`);
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

  function formatUploadErrorMessage(rawMessage) {
    const message = (rawMessage || 'Upload failed.').toString().trim();
    let normalized = message;

    if (/unexpected token|not valid json|unexpected response/i.test(message)) {
      normalized = 'Upload failed because the server returned an invalid response.';
    } else if (/network|failed to fetch|http 5\d\d/i.test(message)) {
      normalized = 'Upload failed due to a temporary network/server issue.';
    }

    return `${normalized} Please refresh the page and try again. If it repeats, send us a screenshot and the exact time. / ההעלאה נכשלה. נא לרענן את הדף ולנסות שוב. אם זה חוזר, שלחו צילום מסך ושעה מדויקת.`;
  }

  function showUploadError(message) {
    const formatted = formatUploadErrorMessage(message);
    const box = document.querySelector('#upload-error-global') || document.querySelector('#upload-error');
    if (!box) {
      alert(formatted);
      return;
    }
    box.textContent = formatted;
    box.classList.remove('d-none');
  }

  function clearUploadError() {
    document.querySelectorAll('#upload-error-global, #upload-error').forEach((box) => {
      box.textContent = '';
      box.classList.add('d-none');
    });
  }

  function readJsonResponse(response, defaultError, options) {
    const opts = options || {};
    return response.text().then((text) => {
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (_) {
          if (response.ok && opts.allowNonJsonSuccess) {
            return {};
          }
          if (!response.ok) {
            throw new Error(`${defaultError} (HTTP ${response.status})`);
          }
          throw new Error('Server returned an unexpected response. Please refresh and try again.');
        }
      }

      if (!response.ok) {
        throw new Error(payload.error || defaultError);
      }
      return payload;
    });
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

    if (form) {
      maxVideoSizeBytes = Number(form.dataset.maxVideoBytes || DEFAULT_MAX_FILE_SIZE);
      maxProfilePictureSizeBytes = Number(form.dataset.maxProfilePictureBytes || DEFAULT_MAX_FILE_SIZE);
      maxProfilePictures = Number(form.dataset.maxProfilePictures || 10);
      requireProfilePicture = form.dataset.requireProfilePicture === '1';
      maxVideoDurationSeconds = Number(form.dataset.maxVideoDurationSeconds || 0);
    }

    if (videoInput) {
      videoInput.addEventListener('change', handleVideoSelection);
    }

    if (profileInput) {
      profileInput.addEventListener('change', handleProfilePicturesSelection);
    }

    ['first_name_he', 'last_name_he', 'first_name_en', 'last_name_en', 'phone', 'email', 'age', 'height', 'showreel_url', 'role']
      .map((id) => document.getElementById(id))
      .forEach(bindRealtimeValidation);

    document.querySelectorAll('[data-clear-video]').forEach((button) => {
      button.addEventListener('click', clearVideoSelection);
    });

    if (!form) return;

    form.addEventListener('submit', function (event) {
      const fieldsToValidate = ['first_name_he', 'last_name_he', 'first_name_en', 'last_name_en', 'phone', 'email', 'age', 'height', 'showreel_url', 'role']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      const liveFieldsValid = fieldsToValidate.every((field) => {
        field.dataset.touched = '1';
        return updateFieldValidationState(field, true);
      });

      if (requireProfilePicture && profileInput && (!profileInput.files || profileInput.files.length !== 1)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showFileError('profile_pictures', 'Please upload exactly one profile picture.');
        form.classList.add('was-validated');
        return;
      }

      if (!liveFieldsValid) {
        event.preventDefault();
        event.stopImmediatePropagation();
        form.classList.add('was-validated');
      }
    });

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
      clearUploadError();

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

      const videoInput = form.querySelector('input[name="video"]');
      const videoFile = videoInput && videoInput.files && videoInput.files[0];
      const projectId = form.action.split('/').filter(Boolean).pop();

      // Step 1: POST form fields + profile pictures (no video) → get submissionId
      var fieldsData = new FormData(form);
      if (videoFile) fieldsData.delete('video'); // Remove video, we upload it separately via tus

      fetch('/audition/' + projectId + '/fields', { method: 'POST', body: fieldsData })
        .then(function(r) { return readJsonResponse(r, 'Could not validate the submission.'); })
        .then(function(fieldsResult) {
          if (!fieldsResult.submissionId) throw new Error('No submissionId from server');
          var submissionId = fieldsResult.submissionId;

          if (!videoFile) {
            // No video - just poll immediately
            pollUploadJob(submissionId, form.action, uploadUi, function() { youtubeSubmitInFlight = false; });
            return;
          }

          var submissionToken = fieldsResult.submissionToken || '';

          // Step 2: Upload video in 2MB binary chunks — each PUT is a separate short
          // HTTP request so Heroku's 90s idle timeout can never trigger.
          // Smaller chunks (2MB) ensure the progress bar updates frequently even on slow connections.
          var CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
          var totalChunks = Math.ceil(videoFile.size / CHUNK_SIZE);
          var currentChunk = 0;

          function uploadNextChunk(retryCount) {
            retryCount = retryCount || 0;
            var start = currentChunk * CHUNK_SIZE;
            var end = Math.min(start + CHUNK_SIZE, videoFile.size);
            var chunk = videoFile.slice(start, end);

            fetch('/upload-chunk/' + submissionId + '/' + currentChunk, {
              method: 'PUT',
              body: chunk,
              headers: { 'Content-Type': 'application/octet-stream' },
            })
              .then(function(r) {
                if (!r.ok) throw new Error('Chunk ' + currentChunk + ' failed: HTTP ' + r.status);
                return readJsonResponse(r, 'Chunk upload failed.', { allowNonJsonSuccess: true });
              })
              .then(function() {
                currentChunk++;
                var pct = Math.max(1, Math.min(98, Math.round((currentChunk / totalChunks) * 100)));
                setYoutubeUploadUi(uploadUi, pct, pct + '%');

                if (currentChunk < totalChunks) {
                  uploadNextChunk(0);
                } else {
                  // All chunks uploaded — tell server to assemble and start YouTube background job
                  function requestAssemble(assembleRetryCount) {
                    fetch('/upload-chunk/' + submissionId + '/assemble', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        submissionId: submissionId,
                        totalChunks: totalChunks,
                        filename: videoFile.name,
                        mimetype: videoFile.type,
                        submissionToken: submissionToken,
                      }),
                    })
                      .then(function(r) { return readJsonResponse(r, 'Could not prepare the uploaded video.'); })
                      .then(function(result) {
                        if (!result.jobId) throw new Error('No jobId from assemble');
                        setYoutubeUploadUi(uploadUi, 99, 'Processing on server...');
                        pollUploadJob(result.jobId, form.action, uploadUi, function() { youtubeSubmitInFlight = false; });
                      })
                      .catch(function(err) {
                        if (assembleRetryCount < 3) {
                          console.warn('Assemble error, retrying...', err);
                          setTimeout(function() { requestAssemble(assembleRetryCount + 1); }, 2000);
                        } else {
                          console.error('Assemble error final:', err);
                          youtubeSubmitInFlight = false;
                          window.location.href = '/audition/' + projectId + '/error';
                        }
                      });
                  }

                  requestAssemble(0);
                }
              })
              .catch(function(err) {
                console.warn('Chunk ' + currentChunk + ' upload error, retry ' + retryCount + ':', err);
                if (retryCount < 5) {
                  // Wait longer between retries: 2s, 4s, 6s, etc.
                  setTimeout(function() { uploadNextChunk(retryCount + 1); }, (retryCount + 1) * 2000);
                } else {
                  console.error('Chunk upload error final:', err);
                  youtubeSubmitInFlight = false;
                  window.location.href = '/audition/' + projectId + '/error';
                }
              });
          }

          uploadNextChunk(0);
        })
        .catch(function(err) {
          console.error('Fields submit error:', err);
          youtubeSubmitInFlight = false;
          showUploadError(err.message || 'Could not validate the submission.');
          resetYoutubeUploadUi(uploadUi);
        });
    });
  });

  function pollUploadJob(jobId, formAction, uploadUi, onDone) {
    fetch('/upload-status/' + jobId)
      .then(function(r) { return readJsonResponse(r, 'Could not check upload status.'); })
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
