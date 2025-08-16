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

					function useTusIfAvailable() {
						return typeof window.tus !== 'undefined' && window.tus && typeof window.tus.Upload === 'function';
					}

					async function uploadWithTus({ file, uploadUrl, accessKey, onProgress }) {
						return new Promise((resolve, reject) => {
							if (!useTusIfAvailable()) return reject(new Error('tus not available'));
							// Bunny supports PUT to /videos/{guid}. tus typically expects an endpoint that accepts creation.
							// We simulate tus by using the existing resource URL with X-HTTP-Method-Override when needed.
							const options = {
								endpoint: uploadUrl, // Using full resource URL
								chunkSize: 5 * 1024 * 1024,
								retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
								removeFingerprintOnSuccess: true,
								overridePatchMethod: true,
								headers: {
									'AccessKey': accessKey,
									'Content-Type': file.type || 'application/octet-stream'
								},
								metadata: {
									filename: file.name,
									filetype: file.type || 'application/octet-stream'
								},
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
								const upload = new window.tus.Upload(file, options);
								upload.start();
							} catch (e) {
								reject(e);
							}
						});
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

	// Enhance audition form if present and project upload method is Bunny Stream
	document.addEventListener('DOMContentLoaded', () => {
		const form = document.querySelector('form#audition-form');
		const videoInput = document.querySelector('input[type="file"][name="video"]');
		const methodEl = document.querySelector('[data-upload-method]');
		const progressBar = document.querySelector('#upload-progress');
		const progressText = document.querySelector('#upload-progress-text');
		const directUi = document.querySelector('#direct-upload-ui');
		const libIdEl = document.querySelector('[data-bunny-library-id]');

		const isBunny = methodEl && methodEl.getAttribute('data-upload-method') === 'cloudflare';
		if (!form || !videoInput || !isBunny || !libIdEl) return; // Fall back to normal submit

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
					const progressFn = (pct) => {
						if (progressText) progressText.textContent = pct + '%';
						if (progressBar) progressBar.value = pct;
					};
					try {
						// Prefer tus if available
						await uploadWithTus({ file, uploadUrl: meta.uploadUrl, accessKey, onProgress: progressFn });
					} catch (_) {
						// Fallback to single PUT if tus path fails
						await uploadToBunny({ file, uploadUrl: meta.uploadUrl, accessKey, onProgress: progressFn });
					}
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
				alert('Upload failed: ' + err.message);
			}
		});
	});
})();
