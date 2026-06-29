(function () {
	const DIRECT_UPLOAD_METHODS = new Set(['bunny', 'bunny_stream', 'bunnystream', 'cloudflare']);
	const MAX_FILE_SIZE_BYTES = 400 * 1024 * 1024; // 400MB hard cap
	const MAX_DURATION_SECONDS = 7 * 60; // 7 minutes
	const MAX_VIDEO_HEIGHT = 1080;
	let currentUpload = null;
	let pendingMetadata = null;

	async function createBunnyVideo({ title, projectId, role, captchaToken }) {
		const response = await fetch('/api/videos', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: title || 'audition',
				projectId: projectId || null,
				role: role || null,
				captchaToken: captchaToken || null,
			}),
		});
		let payload = {};
		try {
			payload = await response.json();
		} catch (_) {}
		if (!response.ok) throw new Error(payload.error || 'Failed to create Bunny video');
		return payload;
	}

	function uploadViaTus({ file, uploadMeta, onProgress }) {
		return new Promise((resolve, reject) => {
			if (!window.tus || !window.tus.Upload) {
				reject(new Error('Upload library is unavailable. Please refresh and try again.'));
				return;
			}

			let settled = false;
			const endpoint = uploadMeta.tusEndpoint || 'https://video.bunnycdn.com/tusupload';
			const upload = new window.tus.Upload(file, {
				endpoint,
				retryDelays: [0, 3000, 5000, 10000, 20000, 60000],
				removeFingerprintOnSuccess: true,
				headers: {
					AuthorizationSignature: uploadMeta.authorizationSignature,
					AuthorizationExpire: String(uploadMeta.authorizationExpire),
					VideoId: uploadMeta.guid,
					LibraryId: String(uploadMeta.libraryId),
				},
				metadata: {
					filetype: file.type || 'application/octet-stream',
					title: file.name || uploadMeta.title || 'audition',
				},
				onProgress: (bytesUploaded, bytesTotal) => {
					if (!bytesTotal || typeof onProgress !== 'function') return;
					const pct = Math.round((bytesUploaded / bytesTotal) * 100);
					onProgress(pct, bytesUploaded, bytesTotal);
				},
				onError: (error) => {
					if (settled) return;
					settled = true;
					currentUpload = null;
					reject(error instanceof Error ? error : new Error(String(error)));
				},
				onSuccess: () => {
					if (settled) return;
					settled = true;
					currentUpload = null;
					resolve();
				},
			});

			currentUpload = {
				abort: () => {
					if (settled) return Promise.resolve();
					settled = true;
					const abortError = new Error('Upload aborted');
					abortError.name = 'AbortError';
					currentUpload = null;
					return upload.abort(true).catch(() => {}).then(() => reject(abortError));
				},
			};

			upload.findPreviousUploads()
				.then((previousUploads) => {
					if (previousUploads && previousUploads.length > 0) {
						upload.resumeFromPreviousUpload(previousUploads[0]);
					}
					upload.start();
				})
				.catch(() => {
					upload.start();
				});
		});
	}

	function formatBytes(bytes) {
		if (!Number.isFinite(bytes)) return '';
		const units = ['bytes', 'KB', 'MB', 'GB'];
		const k = 1024;
		const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
		return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}

	function readVideoMetadata(file) {
		return new Promise((resolve, reject) => {
			const video = document.createElement('video');
			video.preload = 'metadata';
			const url = URL.createObjectURL(file);
			const clean = () => URL.revokeObjectURL(url);
			video.onloadedmetadata = () => {
				clean();
				resolve({
					duration: Number.isFinite(video.duration) ? video.duration : null,
					height: video.videoHeight || null,
					width: video.videoWidth || null,
				});
			};
			video.onerror = () => {
				clean();
				reject(new Error('metadata_unavailable'));
			};
			video.src = url;
		});
	}

	async function enforceVideoLimits(file) {
		if (!file) return null;
		if (file.size > MAX_FILE_SIZE_BYTES) {
			return `Video is too large (${formatBytes(file.size)}). Hard cap is 400MB—please export to 150–250MB at 1080p H.264 (e.g., HandBrake → Fast 1080p30 → 6–8 Mbps or RF 22–24).`;
		}
		try {
			if (!pendingMetadata || pendingMetadata.file !== file) {
				const meta = await readVideoMetadata(file);
				pendingMetadata = { file, meta };
			}
			const { meta } = pendingMetadata;
			if (meta && Number.isFinite(meta.duration) && meta.duration > MAX_DURATION_SECONDS) {
				return 'Video is longer than 7 minutes. Please trim or compress it before uploading.';
			}
			if (meta && meta.height && meta.width) {
				// Use the shorter dimension so vertical (portrait) videos aren't wrongly rejected.
				// A vertical 1080×1920 has a short side of 1080 — that's fine.
				const shortSide = Math.min(meta.width, meta.height);
				if (shortSide > MAX_VIDEO_HEIGHT + 4) {
					return 'Video resolution exceeds 1080p. Please export to 1080p or lower.';
				}
			}
		} catch (err) {
			// If metadata cannot be read we allow the upload but keep existing size guard.
		}
		return null;
	}

	document.addEventListener('DOMContentLoaded', () => {
		const form = document.querySelector('form#audition-form');
		if (!form) return;

		const method = (form.getAttribute('data-upload-method') || '').toLowerCase();
		if (!DIRECT_UPLOAD_METHODS.has(method)) return;

		const videoInput = form.querySelector('input[type="file"][name="video"]');
		if (!videoInput) return;

		const directUi = document.querySelector('#direct-upload-ui');
		const progressBar = document.querySelector('#upload-progress');
		const progressText = document.querySelector('#upload-progress-text');
		const overlayBar = document.querySelector('#overlay-upload-progress-bar');
		const overlayText = document.querySelector('#overlay-upload-progress-text');
		const overlay = document.querySelector('#loading-overlay');
		const submitBtn = document.querySelector('#submit-btn');
		const submitText = document.querySelector('#submit-text');
		const submitSpinner = document.querySelector('#submit-spinner');
		const errorBox = document.querySelector('#upload-error');
		const resumeHint = document.querySelector('#resume-upload-hint');
		const btnPause = document.querySelector('#btn-upload-pause');
		const btnResume = document.querySelector('#btn-upload-resume');
		const btnCancel = document.querySelector('#btn-upload-cancel');

		if (resumeHint) resumeHint.classList.add('d-none');
		if (btnPause) {
			btnPause.classList.add('d-none');
			btnPause.disabled = true;
		}
		if (btnResume) {
			btnResume.classList.add('d-none');
			btnResume.disabled = true;
		}

		function setControls(state) {
			if (btnPause) btnPause.disabled = !!state.pauseDisabled;
			if (btnResume) btnResume.disabled = !!state.resumeDisabled;
			if (btnCancel) btnCancel.disabled = !!state.cancelDisabled;
		}

		function resetProgress() {
			if (progressBar) progressBar.value = 0;
			if (progressText) progressText.textContent = '0%';
			if (overlayBar) overlayBar.style.width = '0%';
			if (overlayText) overlayText.textContent = '0%';
		}

		function showError(message) {
			if (!errorBox) return;
			errorBox.textContent = message;
			errorBox.classList.remove('d-none');
		}

		function clearError() {
			if (!errorBox) return;
			errorBox.classList.add('d-none');
			errorBox.textContent = '';
		}

		const beforeUnloadHandler = (event) => {
			if (!currentUpload) return;
			event.preventDefault();
			event.returnValue = '';
			return '';
		};

		function setUploadActive(active) {
			if (active) {
				if (overlay) overlay.classList.remove('d-none');
				if (submitBtn) submitBtn.disabled = true;
				if (submitSpinner) submitSpinner.classList.remove('d-none');
				if (submitText) submitText.classList.add('d-none');
				window.addEventListener('beforeunload', beforeUnloadHandler);
			} else {
				if (overlay) overlay.classList.add('d-none');
				if (submitBtn) submitBtn.disabled = false;
				if (submitSpinner) submitSpinner.classList.add('d-none');
				if (submitText) submitText.classList.remove('d-none');
				window.removeEventListener('beforeunload', beforeUnloadHandler);
			}
		}

		function updateProgress(pct) {
			if (progressBar) progressBar.value = pct;
			if (progressText) progressText.textContent = pct + '%';
			if (overlayBar) overlayBar.style.width = pct + '%';
			if (overlayText) overlayText.textContent = pct + '%';
		}

		if (btnCancel) {
			btnCancel.addEventListener('click', () => {
				if (!currentUpload) return;
				currentUpload.abort();
			});
		}

		setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: true });
		resetProgress();
		try {
			localStorage.removeItem('auditionUploadResume');
		} catch (_) {}

		videoInput.addEventListener('change', async () => {
			clearError();
			pendingMetadata = null;
			videoInput.removeAttribute('data-rejected');
			const file = videoInput.files && videoInput.files[0];
			if (!file) return;
			const validationMessage = await enforceVideoLimits(file);
			if (validationMessage) {
				showError(validationMessage);
				videoInput.value = '';
				videoInput.setAttribute('data-rejected', '1');
			}
		});

		form.addEventListener('submit', async (event) => {
			// Block submission if the user selected a video that was rejected
			if (videoInput.getAttribute('data-rejected')) {
				event.preventDefault();
				showError('Please select a valid video file before submitting, or remove the video.');
				return;
			}

			const file = videoInput.files && videoInput.files[0];
			if (!file) return;

			event.preventDefault();
			clearError();
			const captchaRequired = (form.getAttribute('data-direct-captcha-required') || '').toLowerCase() === 'true';
			const captchaInput = form.querySelector('input[name="cf-turnstile-response"]');
			const captchaToken = captchaInput ? (captchaInput.value || '').trim() : '';
			if (captchaRequired && !captchaToken) {
				showError('Please complete the human verification check before uploading.');
				return;
			}
			const validationMessage = await enforceVideoLimits(file);
			if (validationMessage) {
				showError(validationMessage);
				return;
			}

			try {
				setUploadActive(true);
				resetProgress();
				if (directUi) directUi.classList.remove('d-none');
				setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: false });
				videoInput.disabled = true;

				let meta;
				try {
					const actionPath = form.getAttribute('action') || '';
					const projectMatch = actionPath.match(/\/audition\/(\d+)/);
					const projectId = projectMatch ? projectMatch[1] : null;
					const roleInput = form.querySelector('[name="role"]');
					const roleName = roleInput ? roleInput.value : null;
					meta = await createBunnyVideo({
						title: file.name,
						projectId,
						role: roleName,
						captchaToken,
					});
				} catch (createErr) {
					throw new Error('Step 1 failed (create video): ' + (createErr && createErr.message ? createErr.message : createErr));
				}
				if (!meta || !meta.guid) throw new Error('Failed to prepare video for upload (no guid returned)');

				const progressFn = (pct) => updateProgress(pct);
				try {
					await uploadViaTus({ file, uploadMeta: meta, onProgress: progressFn });
				} catch (uploadErr) {
					throw new Error('Step 2 failed (upload): ' + (uploadErr && uploadErr.message ? uploadErr.message : uploadErr));
				}
				updateProgress(100);
				if (progressText) progressText.textContent = 'Upload complete. Finalizing submission...';
				if (overlayText) overlayText.textContent = 'Upload complete. Finalizing submission...';
				setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: true });
				clearError();

				let hidden = form.querySelector('input[name="video_url"]');
				if (!hidden) {
					hidden = document.createElement('input');
					hidden.type = 'hidden';
					hidden.name = 'video_url';
					form.appendChild(hidden);
				}
				hidden.value = meta.guid;
				let intentHidden = form.querySelector('input[name="video_upload_intent"]');
				if (!intentHidden) {
					intentHidden = document.createElement('input');
					intentHidden.type = 'hidden';
					intentHidden.name = 'video_upload_intent';
					form.appendChild(intentHidden);
				}
				intentHidden.value = meta.uploadIntent || '';

				videoInput.value = '';
				videoInput.disabled = true;
				form.submit();
			} catch (error) {
				videoInput.disabled = false;
				setUploadActive(false);
				setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: true });

				if (error && error.name === 'AbortError') {
					resetProgress();
					clearError();
					return;
				}

				showError(error && error.message ? error.message : 'Upload failed');
			}
		});
	});
})();
