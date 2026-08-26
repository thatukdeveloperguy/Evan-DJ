let player = null;
let ready = false;
let playlistResolver = null;
let playlistResolverReady = false;
let pendingPlaylistResolve = null;
let playlistResolveTimer = null;
let playlistResolveChecks = [];
let pendingAudio = null;
let currentVideoId = null;
let currentLocationId = null;
let currentVolume = 0;
let uiLocationId = null;
let lastTitleReportKey = null;

const app = document.getElementById('djApp');
const closeBtn = document.getElementById('closeBtn');
const addBtn = document.getElementById('addBtn');
const skipBtn = document.getElementById('skipBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const locationName = document.getElementById('locationName');
const nowPlaying = document.getElementById('nowPlaying');
const queueList = document.getElementById('queueList');
const urlInput = document.getElementById('urlInput');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const statusMessage = document.getElementById('statusMessage');
let statusTimer = null;

function nuiPost(name, data = {}) {
    return fetch(`https://${GetParentResourceName()}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}

function normaliseVolume(volume) {
    let value = Number(volume);
    if (!Number.isFinite(value)) value = 0.75;
    if (value < 0) value = 0;
    if (value > 1) value = 1;
    return value;
}

function updateVolumeSlider(volume) {
    const percent = Math.round(normaliseVolume(volume) * 100);
    volumeSlider.value = String(percent);
    volumeValue.textContent = `${percent}%`;
}

function showStatus(message, statusType = 'info') {
    const text = String(message || '').trim();
    if (!text) return;

    if (statusTimer) clearTimeout(statusTimer);

    statusMessage.textContent = text;
    statusMessage.className = `status-message ${statusType}`;

    statusTimer = setTimeout(() => {
        statusMessage.classList.add('hidden');
    }, statusType === 'info' ? 8000 : 5000);
}

function cleanDisplayTitle(song) {
    if (!song) return 'Nothing playing';
    return song.title || song.url || song.videoId || 'YouTube Video';
}

function reportYouTubeTitle() {
    if (!ready || !player || !currentVideoId || currentLocationId == null) return;
    if (typeof player.getVideoData !== 'function') return;

    const info = player.getVideoData() || {};
    const title = String(info.title || '').trim();

    if (!title || title === 'YouTube Video') return;

    const key = `${currentLocationId}:${currentVideoId}:${title}`;
    if (lastTitleReportKey === key) return;
    lastTitleReportKey = key;

    nuiPost('songTitleFound', {
        locationId: currentLocationId,
        videoId: currentVideoId,
        title
    });
}

function scheduleTitleChecks() {
    setTimeout(reportYouTubeTitle, 500);
    setTimeout(reportYouTubeTitle, 1500);
    setTimeout(reportYouTubeTitle, 3000);
    setTimeout(reportYouTubeTitle, 6000);
}

function clearPlaylistResolveTimers() {
    if (playlistResolveTimer) {
        clearTimeout(playlistResolveTimer);
        playlistResolveTimer = null;
    }

    playlistResolveChecks.forEach((timer) => clearTimeout(timer));
    playlistResolveChecks = [];
}

function finishPlaylistResolve(success, message) {
    const request = pendingPlaylistResolve;
    if (!request) return;

    clearPlaylistResolveTimers();
    pendingPlaylistResolve = null;

    if (!success) {
        nuiPost('playlistResolveFailed', {
            locationId: request.locationId,
            playlistId: request.playlistId,
            message: message || 'The playlist could not be read by YouTube.'
        });
    }
}

function tryReadResolvedPlaylist() {
    const request = pendingPlaylistResolve;
    if (!request || !playlistResolverReady || !playlistResolver) return;
    if (typeof playlistResolver.getPlaylist !== 'function') return;

    const playlist = playlistResolver.getPlaylist();
    if (!Array.isArray(playlist) || playlist.length <= 0) return;

    const maximum = Math.max(1, Math.min(500, Number(request.maximum) || 200));
    const videoIds = playlist
        .map((videoId) => String(videoId || '').trim())
        .filter((videoId) => /^[A-Za-z0-9_-]{6,32}$/.test(videoId))
        .slice(0, maximum);

    if (videoIds.length <= 0) return;

    clearPlaylistResolveTimers();
    pendingPlaylistResolve = null;

    nuiPost('playlistResolved', {
        locationId: request.locationId,
        playlistId: request.playlistId,
        videoIds
    });
}

function beginPlaylistResolve(data) {
    const playlistId = String((data && data.playlistId) || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(playlistId)) {
        nuiPost('playlistResolveFailed', {
            locationId: data && data.locationId,
            playlistId,
            message: 'That playlist ID is not valid.'
        });
        return;
    }

    pendingPlaylistResolve = {
        locationId: Number(data.locationId) || null,
        playlistId,
        maximum: Number(data.maximum) || 200
    };

    clearPlaylistResolveTimers();

    if (!playlistResolverReady || !playlistResolver) {
        playlistResolveTimer = setTimeout(() => {
            finishPlaylistResolve(false, 'The YouTube playlist reader did not become ready.');
        }, 15000);
        return;
    }

    try {
        playlistResolver.mute();
        playlistResolver.cuePlaylist({
            listType: 'playlist',
            list: playlistId,
            index: 0,
            startSeconds: 0
        });
    } catch (error) {
        finishPlaylistResolve(false, 'YouTube rejected that playlist link.');
        return;
    }

    [400, 800, 1500, 2500, 4000, 6500, 9000].forEach((delay) => {
        playlistResolveChecks.push(setTimeout(tryReadResolvedPlaylist, delay));
    });

    playlistResolveTimer = setTimeout(() => {
        finishPlaylistResolve(false, 'No playable videos were found in that playlist.');
    }, 12000);
}

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '1',
        width: '1',
        videoId: '',
        playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            origin: window.location.origin
        },
        events: {
            onReady: function () {
                ready = true;

                if (pendingAudio) {
                    playAudio(pendingAudio);
                    pendingAudio = null;
                }
            },
            onStateChange: function (event) {
                if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.CUED) {
                    scheduleTitleChecks();
                }

                if (event.data === YT.PlayerState.ENDED) {
                    nuiPost('songEnded', {
                        videoId: currentVideoId,
                        locationId: currentLocationId
                    });
                }
            },
            onError: function () {
                // Keep this silent. Do not spam server sync when YouTube blocks a video.
            }
        }
    });

    playlistResolver = new YT.Player('playlistResolver', {
        height: '1',
        width: '1',
        videoId: '',
        playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            origin: window.location.origin
        },
        events: {
            onReady: function () {
                playlistResolverReady = true;
                playlistResolver.mute();

                if (pendingPlaylistResolve) {
                    beginPlaylistResolve(pendingPlaylistResolve);
                }
            },
            onStateChange: function () {
                tryReadResolvedPlaylist();
            },
            onError: function () {
                // Keep checking getPlaylist()
                setTimeout(tryReadResolvedPlaylist, 100);
            }
        }
    });
}

function setPlayerVolume(volume) {
    currentVolume = Math.floor(normaliseVolume(volume) * 100);

    if (!ready || !player) return;

    player.setVolume(currentVolume);

    if (currentVolume > 0 && currentVideoId && typeof player.playVideo === 'function') {
        player.playVideo();
    }
}

function playAudio(data) {
    if (!data || !data.videoId) return;

    if (!ready || !player) {
        pendingAudio = data;
        return;
    }

    const volume = normaliseVolume(data.volume);
    const startSeconds = Math.max(0, Number(data.startSeconds) || 0);
    const sameAudio = currentVideoId === data.videoId && currentLocationId === data.locationId;

    if (sameAudio) {
        setPlayerVolume(volume);
        scheduleTitleChecks();
        return;
    }

    currentVideoId = data.videoId;
    currentLocationId = data.locationId;
    lastTitleReportKey = null;

    player.loadVideoById({
        videoId: data.videoId,
        startSeconds
    });

    setPlayerVolume(volume);
    player.playVideo();
    scheduleTitleChecks();
}

function stopAudio() {
    currentVideoId = null;
    currentLocationId = null;
    pendingAudio = null;

    if (!ready || !player) return;
    player.stopVideo();
}

function renderQueue(queue = []) {
    queueList.innerHTML = '';

    if (!queue || queue.length <= 0) {
        queueList.innerHTML = '<p>No songs queued.</p>';
        return;
    }

    queue.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.textContent = `${index + 1}. ${cleanDisplayTitle(song)}`;
        queueList.appendChild(item);
    });
}

function updateNowPlaying(song) {
    nowPlaying.textContent = cleanDisplayTitle(song);
}

function updateBoothUI(data) {
    uiLocationId = data.locationId || uiLocationId;
    locationName.textContent = data.location || 'DJ Booth';
    updateNowPlaying(data.currentSong);
    renderQueue(data.queue || []);
    updateVolumeSlider(data.boothVolume);
}

closeBtn.addEventListener('click', function () {
    nuiPost('closeUI');
});

function submitYouTubeLink() {
    const url = urlInput.value.trim();
    if (!url) return;

    showStatus('Adding to queue...', 'info');
    nuiPost('addSong', { url });
    urlInput.value = '';
}

addBtn.addEventListener('click', submitYouTubeLink);

urlInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitYouTubeLink();
    }
});

let volumePostTimer = null;

function postBoothVolume() {
    nuiPost('setBoothVolume', {
        volume: Number(volumeSlider.value) / 100
    });
}

function queueBoothVolumePost() {
    if (volumePostTimer) clearTimeout(volumePostTimer);
    volumePostTimer = setTimeout(postBoothVolume, 100);
}

volumeSlider.addEventListener('input', function () {
    const volume = Number(volumeSlider.value) / 100;
    updateVolumeSlider(volume);
    setPlayerVolume(volume);
    queueBoothVolumePost();
});

volumeSlider.addEventListener('change', function () {
    postBoothVolume();
});

skipBtn.addEventListener('click', function () {
    nuiPost('skipSong');
});

stopBtn.addEventListener('click', function () {
    nuiPost('stopSong');
});

refreshBtn.addEventListener('click', function () {
    nuiPost('requestQueue');
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
        nuiPost('closeUI');
    }
});

window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || !data.action) return;

    if (data.action === 'openUI') {
        app.classList.remove('hidden');
    }

    if (data.action === 'closeUI') {
        app.classList.add('hidden');
    }

    if (data.action === 'updateBooth') {
        updateBoothUI(data);
    }

    if (data.action === 'playlistStatus') {
        showStatus(data.message, data.statusType || 'info');
    }

    if (data.action === 'resolvePlaylist') {
        showStatus('Reading YouTube playlist...', 'info');
        beginPlaylistResolve(data);
    }

    if (data.action === 'playAudio') {
        playAudio(data);
    }

    if (data.action === 'setAudioVolume') {
        setPlayerVolume(data.volume);
    }

    if (data.action === 'stopAudio') {
        stopAudio();
    }
});
