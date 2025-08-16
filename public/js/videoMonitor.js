// public/js/videoMonitor.js
// Unified VideoMonitor for Bunny.net (canonical) and legacy Cloudflare

class VideoMonitor {
  constructor({ videoUid, apiUrl, maxChecks, readyCheck, onReady, onWarning }) {
    this.videoUid = videoUid;
    this.apiUrl = apiUrl;
    this.isVideoReady = false;
    this.checkCount = 0;
    this.maxChecks = maxChecks || 20;
    this.destroyed = false;
    this.readyCheck = readyCheck;
    this.onReady = onReady;
    this.onWarning = onWarning;
    this.debugEl = document.getElementById('video-debug');
  }
  start() { this.checkVideoStatus(); }
  destroy() { this.destroyed = true; }
  async checkVideoStatus() {
    if (this.destroyed) return;
    this.checkCount++;
    try {
      const res = await fetch(this.apiUrl.replace(':videoUid', this.videoUid));
      const data = await res.json();
      if (window.VIDEO_DEBUG && this.debugEl) {
        this.appendDebug(`Poll #${this.checkCount}: ${new Date().toLocaleTimeString()} => ${JSON.stringify(data)}`);
      }
      if (this.readyCheck(data)) {
        this.onReady();
        return;
      }
    } catch (e) { console.warn('Status check failed:', e); }
    this.updateStatusMessage();
    this.scheduleNextCheck();
  }
  appendDebug(msg) {
    if (!this.debugEl) return;
    if (this.debugEl.style.display === 'none') this.debugEl.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = msg;
    this.debugEl.appendChild(line);
    // Keep last 50 lines
    while (this.debugEl.childNodes.length > 50) {
      this.debugEl.removeChild(this.debugEl.firstChild);
    }
  }
  updateStatusMessage() {
    const statusElement = document.querySelector('#video-processing small');
    if (!statusElement) return;
    if (this.checkCount <= 2) {
      statusElement.innerHTML = '<i class="fas fa-upload me-1"></i>Processing video for streaming...';
    } else if (this.checkCount <= 5) {
      statusElement.innerHTML = '<i class="fas fa-cog me-1"></i>Optimizing video quality...';
    } else {
      statusElement.innerHTML = '<i class="fas fa-check me-1"></i>Almost ready for playback...';
    }
  }
  scheduleNextCheck() {
    if (this.checkCount >= this.maxChecks || this.destroyed) {
      this.onWarning();
      return;
    }
    let delay = this.checkCount <= 5 ? 3000 : 5000;
    setTimeout(() => { if (!this.destroyed) this.checkVideoStatus(); }, delay);
  }
}

window.VideoMonitor = VideoMonitor;
