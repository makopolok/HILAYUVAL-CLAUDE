(function() {
	// Secure direct-to-Bunny upload helper using our secure API proxy
	// This avoids routing the large file through Heroku while keeping API keys safe

	async function createBunnyVideo(title) {
		const res = await fetch('/api/videos?title=' + encodeURIComponent(title || 'audition'), {
			method: 'POST'
		});
		if (!res.ok) throw new Error('Failed to create Bunny video');
		return res.json();
	}

	// Get a secure token for uploading to this video
	async function getUploadToken(guid) {
		const res = await fetch(`/api/videos/${guid}/auth`, {
			method: 'POST'
		});
		if (!res.ok) throw new Error('Failed to get upload authorization');
		return res.json();
	}

	// Upload a file through our secure proxy
	function uploadSecurely({ file, guid, token, onProgress }) {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', `/api/upload/${guid}`, true);
			xhr.setRequestHeader('X-Upload-Token', token);
			xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable && typeof onProgress === 'function') {
					onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
				}
			};
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) return resolve();
				reject(new Error('Upload failed with status ' + xhr.status));
			};
			xhr.onerror = () => reject(new Error('Network error during upload'));
			xhr.send(file);
		});
	}

	function useTusIfAvailable() {
		return typeof window.tus !== 'undefined' && window.tus && typeof window.tus.Upload === 'function';
	}

	// Enhance audition form if present and project upload method is Bunny Stream
	document.addEventListener('DOMContentLoaded', () => {
		const form = document.querySelector('form#audition-form');
		const videoInput = document.querySelector('input[type="file"][name="video"]');
		const methodEl = document.querySelector('[data-upload-method]');
		const progressBar = document.querySelector('#upload-progress');
		const progressText = document.querySelector('#upload-progress-text');
		const overlayBar = document.querySelector('#overlay-upload-progress-bar');
		const overlayText = document.querySelector('#overlay-upload-progress-text');
		const directUi = document.querySelector('#direct-upload-ui');
		const libIdEl = document.querySelector('[data-bunny-library-id]');
		const resumeHint = document.querySelector('#resume-upload-hint');

		const methodVal = methodEl && methodEl.getAttribute('data-upload-method');
		const isBunny = methodVal && ['cloudflare','bunny','bunny_stream','bunnystream'].includes(methodVal);
		if (!form || !videoInput || !isBunny || !libIdEl) return; // Fall back to normal submit

		// If there was an interrupted upload, show a resume hint
		try {
			const pending = localStorage.getItem('auditionUploadResume');
			if (pending && resumeHint) {
				const info = JSON.parse(pending);
				if (info && info.filename && info.size) {
					resumeHint.classList.remove('d-none');
					const nameEl = resumeHint.querySelector('[data-name]');
					const sizeEl = resumeHint.querySelector('[data-size]');
					if (nameEl) nameEl.textContent = info.filename;
					if (sizeEl) sizeEl.textContent = Math.round(info.size / (1024*1024)) + ' MB';
				}
			}
		} catch (_) {}

		function setUploadActive(active) {
			if (active) {
				window.__directUploadActive = true;
				window.addEventListener('beforeunload', beforeUnloadHandler);
			} else {
				window.__directUploadActive = false;
				window.removeEventListener('beforeunload', beforeUnloadHandler);
			}
		}
		function beforeUnloadHandler(e) {
			if (window.__directUploadActive) {
				e.preventDefault();
				e.returnValue = '';
				return '';
			}
		}

		// Pause/Resume/Cancel controls
		const btnPause = document.querySelector('#btn-upload-pause');
		const btnResume = document.querySelector('#btn-upload-resume');
		const btnCancel = document.querySelector('#btn-upload-cancel');
		const errorBox = document.querySelector('#upload-error');

		function setControls({ pauseDisabled, resumeDisabled, cancelDisabled }) {
			if (btnPause) btnPause.disabled = !!pauseDisabled;
			if (btnResume) btnResume.disabled = !!resumeDisabled;
			if (btnCancel) btnCancel.disabled = !!cancelDisabled;
		}
		function showError(msg) {
			if (!errorBox) return;
			errorBox.textContent = msg;
			errorBox.classList.remove('d-none');
		}
		function clearError() {
			if (!errorBox) return;
			errorBox.classList.add('d-none');
			errorBox.textContent = '';
		}

		// Intercept submit to perform direct upload
		form.addEventListener('submit', async (e) => {
			const file = videoInput.files && videoInput.files[0];
			if (!file) return; // Let server handle no-file case
			// Only intercept for bunny_stream flow
			e.preventDefault();
			try {
				// 1) Create video via our secure API
				const meta = await createBunnyVideo(file.name);
				// 2) Get a secure upload token
				const auth = await getUploadToken(meta.guid);
				
				if (directUi) directUi.classList.remove('d-none');
				if (progressBar) progressBar.value = 0;
				setUploadActive(true);
				// Save minimal resume info
				try {
					localStorage.setItem('auditionUploadResume', JSON.stringify({
						guid: meta.guid,
						filename: file.name,
						size: file.size,
						ts: Date.now()
					}));
				} catch (_) {}
				
				clearError();
				const progressFn = (pct) => {
					if (progressText) progressText.textContent = pct + '%';
					if (progressBar) progressBar.value = pct;
					if (overlayText) overlayText.textContent = pct + '%';
					if (overlayBar) overlayBar.style.width = pct + '%';
				};
				
				// Upload through our secure proxy endpoint
				setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: false });
				await uploadSecurely({ file, guid: meta.guid, token: auth.token, onProgress: progressFn }).catch(err => {
					showError('Upload failed: ' + err.message);
					throw err;
				});
				
				setUploadActive(false);
				try { localStorage.removeItem('auditionUploadResume'); } catch (_) {}
				// 3) Submit a lightweight form with only the GUID (no file)
				const guidInputName = 'video_url';
				let hidden = form.querySelector('input[name="' + guidInputName + '"]');
				if (!hidden) {
					hidden = document.createElement('input');
					hidden.type = 'hidden';
					hidden.name = guidInputName;
					form.appendChild(hidden);
				}
				hidden.value = meta.guid;
				// Remove the file so multer doesn't try to read it
				videoInput.value = '';
				form.submit();
			} catch (err) {
				setUploadActive(false);
				showError((err && err.message) ? err.message : 'Upload failed');
			}
		});

		// Button handlers
		if (btnCancel) {
			btnCancel.addEventListener('click', () => {
				try {
					setUploadActive(false);
					try { localStorage.removeItem('auditionUploadResume'); } catch (_) {}
					if (progressBar) progressBar.value = 0;
					if (progressText) progressText.textContent = '0%';
					setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: true });
				} catch (e) { showError('Cancel failed: ' + e.message); }
			});
		}
	});
})();