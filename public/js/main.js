(function() {
	// Direct-to-Bunny upload helper using plain XHR PUT (resumable via Range requests not supported here).
	// This avoids routing the large file through Heroku. If needed, we can upgrade to tus later.

	async function createBunnyVideo(title) {
		const res = await fetch('/api/videos?title=' + encodeURIComponent(title || 'audition'), {
			method: 'POST'
		});
		if (!res.ok) throw new Error('Failed to create Bunny video');
		return res.json();
	}

	function uploadToBunny({ file, uploadUrl, accessKey, onProgress }) {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', uploadUrl, true);
			xhr.setRequestHeader('AccessKey', accessKey);
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

	async function uploadWithTus({ file, uploadUrl, accessKey, onProgress }) {
		return new Promise((resolve, reject) => {
			if (!useTusIfAvailable()) return reject(new Error('tus not available'));
			// Using the resource URL; Bunny may accept PATCH via override
			const options = {
				endpoint: uploadUrl,
				chunkSize: 5 * 1024 * 1024,
				retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
				removeFingerprintOnSuccess: true,
				overridePatchMethod: true,
				headers: {
					'AccessKey': accessKey,
					'Content-Type': file.type || 'application/octet-stream'
				},
				metadata: { filename: file.name, filetype: file.type || 'application/octet-stream' },
				onError: (error) => reject(error),
				onProgress: (bytesUploaded, bytesTotal) => {
					if (typeof onProgress === 'function' && bytesTotal > 0) {
						const pct = Math.floor((bytesUploaded / bytesTotal) * 100);
						onProgress(pct, bytesUploaded, bytesTotal);
					}
				},
				onSuccess: () => resolve()
			};
			try {
				window.__currentTusOptions = { file, uploadUrl, accessKey, onProgress };
				window.__currentTus = new window.tus.Upload(file, options);
				window.__currentTus.start();
			} catch (e) { reject(e); }
		});
	}	// Enhance audition form if present and project upload method is Bunny Stream
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
				// 1) Create video
				const meta = await createBunnyVideo(file.name);
				// 2) Upload directly to Bunny with AccessKey injected from a meta tag
				const keyMeta = document.querySelector('meta[name="bunny-video-accesskey"]');
				const accessKey = keyMeta && keyMeta.content;
				if (!accessKey) throw new Error('Missing Bunny AccessKey in page');

					if (directUi) directUi.classList.remove('d-none');
			if (progressBar) progressBar.value = 0;
					setUploadActive(true);
					// Save minimal resume info; tus can reuse fingerprint when the same file is picked again
					try {
						localStorage.setItem('auditionUploadResume', JSON.stringify({
							guid: meta.guid,
							uploadUrl: meta.uploadUrl,
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
					try {
						// Prefer tus if available
						await uploadWithTus({ file, uploadUrl: meta.uploadUrl, accessKey, onProgress: progressFn });
								setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: true });
					} catch (_) {
						// Fallback to single PUT if tus path fails
								setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: false });
								await uploadToBunny({ file, uploadUrl: meta.uploadUrl, accessKey, onProgress: progressFn }).catch(err => {
									showError('Upload failed: ' + err.message);
									throw err;
								});
					}
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
				// Remove the file so multer doesn’t try to read it
				videoInput.value = '';
				form.submit();
			} catch (err) {
						setUploadActive(false);
						showError((err && err.message) ? err.message : 'Upload failed');
			}
		});

				// Button handlers
				if (btnPause) {
					btnPause.addEventListener('click', () => {
						try {
							if (window.__currentTus) {
								window.__currentTus.abort(true); // keep resume data
								setControls({ pauseDisabled: true, resumeDisabled: false, cancelDisabled: false });
							} else {
								showError('Pause is only available for resumable uploads.');
							}
						} catch (e) { showError('Pause failed: ' + e.message); }
					});
				}
				if (btnResume) {
					btnResume.addEventListener('click', () => {
						try {
							if (window.__currentTus) {
								window.__currentTus.start();
								setControls({ pauseDisabled: false, resumeDisabled: true, cancelDisabled: false });
							} else {
								showError('Resume is only available for resumable uploads. Re-select the same file to continue.');
							}
						} catch (e) { showError('Resume failed: ' + e.message); }
					});
				}
				if (btnCancel) {
					btnCancel.addEventListener('click', () => {
						try {
							if (window.__currentTus) {
								window.__currentTus.abort(true);
							}
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
