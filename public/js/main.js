(function() {
	// Enhanced general-purpose functions
	
	// Handler for the beforeunload event during active uploads
	function beforeUnloadHandler(e) {
		if (window.__directUploadActive) {
			e.preventDefault();
			e.returnValue = '';
			return '';
		}
	}
	
	// Set the upload active state to prevent accidental navigation
	function setUploadActive(active) {
		if (active) {
			window.__directUploadActive = true;
			window.addEventListener('beforeunload', beforeUnloadHandler);
		} else {
			window.__directUploadActive = false;
			window.removeEventListener('beforeunload', beforeUnloadHandler);
		}
	}

	// Check for interrupted uploads when page loads
	document.addEventListener('DOMContentLoaded', () => {
		// This shows a hint if there was an interrupted upload
		try {
			const resumeHint = document.querySelector('#resume-upload-hint');
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
		
		// Button handlers for cancel upload
		const btnCancel = document.querySelector('#btn-upload-cancel');
		const errorBox = document.querySelector('#upload-error');
		const progressBar = document.querySelector('#upload-progress');
		const progressText = document.querySelector('#upload-progress-text');
		
		function showError(msg) {
			if (!errorBox) return;
			errorBox.textContent = msg;
			errorBox.classList.remove('d-none');
		}
		
		if (btnCancel) {
			btnCancel.addEventListener('click', () => {
				try {
					setUploadActive(false);
					try { localStorage.removeItem('auditionUploadResume'); } catch (_) {}
					if (progressBar) progressBar.value = 0;
					if (progressText) progressText.textContent = '0%';
					
					// Update button states
					const btnPause = document.querySelector('#btn-upload-pause');
					const btnResume = document.querySelector('#btn-upload-resume');
					if (btnPause) btnPause.disabled = true;
					if (btnResume) btnResume.disabled = true;
					if (btnCancel) btnCancel.disabled = true;
					
				} catch (e) { 
					showError('Cancel failed: ' + e.message); 
				}
			});
		}
	});
})();