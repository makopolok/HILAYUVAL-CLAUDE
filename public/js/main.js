(function () {
	const DIRECT_UPLOAD_METHODS = new Set(['bunny', 'bunny_stream', 'bunnystream', 'cloudflare']);
	let currentUpload = null;

	async function createBunnyVideo(title) {
		const response = await fetch('/api/videos?title=' + encodeURIComponent(title || 'audition'), {
			method: 'POST'
		});
		if (!response.ok) throw new Error('Failed to create Bunny video');
		return response.json();
	}

	function uploadViaProxy({ file, guid, onProgress }) {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			currentUpload = xhr;

			xhr.open('PUT', `/api/videos/${encodeURIComponent(guid)}/upload`, true);
			xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
			xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));

			xhr.upload.onprogress = (event) => {
				if (!event.lengthComputable || typeof onProgress !== 'function') return;
				const pct = Math.round((event.loaded / event.total) * 100);
				onProgress(pct, event.loaded, event.total);
			};

			xhr.onload = () => {
				currentUpload = null;
				if (xhr.status >= 200 && xhr.status < 300) return resolve();
				let message = 'Upload failed with status ' + xhr.status;
				try {
					const payload = JSON.parse(xhr.responseText || '{}');
					if (payload && payload.error) message = payload.error;
				} catch (_) {}
				reject(new Error(message));
			};

			xhr.onerror = () => {
				currentUpload = null;
				reject(new Error('Network error during upload'));
			};

			xhr.onabort = () => {
				currentUpload = null;
				const abortError = new Error('Upload aborted');
				abortError.name = 'AbortError';
				reject(abortError);
			};

			try {
				xhr.send(file);
			} catch (err) {
				currentUpload = null;
				reject(err);
			}
		});
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

		form.addEventListener('submit', async (event) => {
			const file = videoInput.files && videoInput.files[0];
			if (!file) return;

			event.preventDefault();
			clearError();

			try {
				const meta = await createBunnyVideo(file.name);
				if (!meta || !meta.guid) throw new Error('Failed to prepare video for upload');

				if (directUi) directUi.classList.remove('d-none');
				resetProgress();
				setUploadActive(true);
				setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: false });
				videoInput.disabled = true;

				const progressFn = (pct) => updateProgress(pct);
				await uploadViaProxy({ file, guid: meta.guid, onProgress: progressFn });
				updateProgress(100);

				setControls({ pauseDisabled: true, resumeDisabled: true, cancelDisabled: true });
				setUploadActive(false);
				videoInput.disabled = false;
				clearError();

				let hidden = form.querySelector('input[name="video_url"]');
				if (!hidden) {
					hidden = document.createElement('input');
					hidden.type = 'hidden';
					hidden.name = 'video_url';
					form.appendChild(hidden);
				}
				hidden.value = meta.guid;

				videoInput.value = '';
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
