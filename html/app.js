const decks = [
    { elementId: 'playerA', player: null, ready: false, videoId: null, locationId: null, preload: false, metadataKey: null },
    { elementId: 'playerB', player: null, ready: false, videoId: null, locationId: null, preload: false, metadataKey: null }
];

let activeDeck = 0;
let pendingAudio = null;
let crossfade = null;
let audioState = {
    locationId: null,
    videoId: null,
    nextSong: null,
    crossfadeSeconds: 4,
    spatialVolume: 0
};

let playlistResolver = null;
let playlistResolverReady = false;
let pendingPlaylistResolve = null;
let playlistResolveTimer = null;
let playlistResolveChecks = [];

let uiLocationId = null;
let latestBoothData = null;
let currentQueue = [];
let statusTimer = null;
let volumePostTimer = null;
let queuePointerDrag = null;

const app = document.getElementById('djApp');
const closeBtn = document.getElementById('closeBtn');
const addBtn = document.getElementById('addBtn');
const skipBtn = document.getElementById('skipBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const locationName = document.getElementById('locationName');
const nowPlaying = document.getElementById('nowPlaying');
const nowAuthor = document.getElementById('nowAuthor');
const nowArtwork = document.getElementById('nowArtwork');
const artworkFallback = document.getElementById('artworkFallback');
const progressBar = document.getElementById('progressBar');
const elapsedTime = document.getElementById('elapsedTime');
const durationTime = document.getElementById('durationTime');
const videoIdLabel = document.getElementById('videoIdLabel');
const crossfadeInfo = document.getElementById('crossfadeInfo');
const crossfadeBadge = document.getElementById('crossfadeBadge');
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const urlInput = document.getElementById('urlInput');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const statusMessage = document.getElementById('statusMessage');

function nuiPost(name, data = {}) {
    return fetch(`https://${GetParentResourceName()}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(() => null);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normaliseVolume(volume) {
    let value = Number(volume);
    if (!Number.isFinite(value)) value = 0.75;
    return clamp(value, 0, 1);
}

function normaliseCrossfadeSeconds(seconds) {
    let value = Number(seconds);
    if (!Number.isFinite(value)) value = 4;
    return clamp(value, 0, 15);
}

function cleanDisplayTitle(song) {
    if (!song) return 'Nothing playing';
    return String(song.title || song.url || song.videoId || 'YouTube Video');
}

function thumbnailUrl(videoId) {
    if (!videoId) return '';
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
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
    }, statusType === 'info' ? 8000 : 5200);
}

function clearDeck(index, stop = true) {
    const deck = decks[index];
    if (!deck) return;

    const player = deck.player;
    const canStop = stop && deck.ready && player && typeof player.stopVideo === 'function';
    deck.videoId = null;
    deck.locationId = null;
    deck.preload = false;
    deck.metadataKey = null;

    if (canStop) {
        try { player.stopVideo(); } catch (_) {}
    }
}

function setDeckVolume(index, volume) {
    const deck = decks[index];
    if (!deck || !deck.ready || !deck.player) return;
    try {
        deck.player.setVolume(Math.round(normaliseVolume(volume) * 100));
    } catch (_) {}
}

function setSpatialVolume(volume) {
    audioState.spatialVolume = normaliseVolume(volume);

    if (crossfade && crossfade.startedAt != null) {
        applyCrossfadeVolumes();
        return;
    }

    setDeckVolume(activeDeck, audioState.spatialVolume);
    setDeckVolume(1 - activeDeck, 0);
}

function decksReady() {
    return decks.every((deck) => deck.ready && deck.player);
}

function getMatchingDeck(videoId, locationId) {
    return decks.findIndex((deck) =>
        deck.videoId === videoId && Number(deck.locationId) === Number(locationId)
    );
}

function scheduleMetadataReport(index) {
    [450, 1200, 2600].forEach((delay) => {
        setTimeout(() => reportDeckMetadata(index), delay);
    });
}

function reportDeckMetadata(index) {
    const deck = decks[index];
    if (!deck || !deck.ready || !deck.player || !deck.videoId || deck.locationId == null) return;
    if (typeof deck.player.getVideoData !== 'function') return;

    let info = {};
    let duration = 0;
    try {
        info = deck.player.getVideoData() || {};
        duration = Number(deck.player.getDuration()) || 0;
    } catch (_) {
        return;
    }

    const title = String(info.title || '').trim();
    const author = String(info.author || '').trim();
    if (!title && duration <= 0) return;

    const key = `${deck.locationId}:${deck.videoId}:${title}:${author}:${Math.round(duration)}`;
    if (deck.metadataKey === key) return;
    deck.metadataKey = key;

    nuiPost('songMetadataFound', {
        locationId: deck.locationId,
        videoId: deck.videoId,
        title,
        author,
        duration
    });
}

function handleDeckError(index, errorCode) {
    const deck = decks[index];
    if (!deck || !deck.videoId) return;

    const payload = {
        locationId: deck.locationId,
        videoId: deck.videoId,
        errorCode: Number(errorCode) || 0
    };

    const isPendingCrossfadeTarget = crossfade && crossfade.to === index && crossfade.startedAt == null;
    const isCurrent = Number(deck.locationId) === Number(audioState.locationId) && deck.videoId === audioState.videoId;

    if (isPendingCrossfadeTarget || (deck.preload && !isCurrent)) {
        nuiPost('queuedSongUnplayable', payload);
        if (uiLocationId != null && Number(uiLocationId) === Number(deck.locationId)) {
            showStatus('A queued track cannot be embedded by YouTube and was removed.', 'error');
        }

        if (crossfade && crossfade.to === index) crossfade = null;
        clearDeck(index, false);
        return;
    }

    nuiPost('songUnplayable', payload);
    if (uiLocationId != null && Number(uiLocationId) === Number(deck.locationId)) {
        showStatus('This track cannot be played here. Skipping automatically.', 'error');
    }
    clearDeck(index, false);
}

function onDeckStateChange(index, event) {
    const deck = decks[index];
    if (!deck) return;

    if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.CUED) {
        scheduleMetadataReport(index);
    }

    if (
        crossfade &&
        crossfade.to === index &&
        crossfade.startedAt == null &&
        event.data === YT.PlayerState.PLAYING
    ) {
        crossfade.startedAt = performance.now();
        crossfadeBadge.classList.remove('hidden');
        if (!crossfade.serverAlreadyAdvanced) {
            nuiPost('beginCrossfade', {
                locationId: crossfade.locationId,
                videoId: crossfade.videoId,
                nextVideoId: crossfade.nextVideoId
            });
        }
    }

    if (event.data === YT.PlayerState.ENDED) {
        if (crossfade && crossfade.from === index) {
            return;
        }

        if (index === activeDeck && deck.videoId) {
            nuiPost('songEnded', {
                locationId: deck.locationId,
                videoId: deck.videoId
            });
        }
    }
}

function createDeck(index) {
    const deck = decks[index];
    deck.player = new YT.Player(deck.elementId, {
        height: '2',
        width: '2',
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
            onReady: () => {
                deck.ready = true;
                setDeckVolume(index, 0);
                if (pendingAudio && decksReady()) {
                    const pending = pendingAudio;
                    pendingAudio = null;
                    playAudio(pending);
                }
            },
            onStateChange: (event) => onDeckStateChange(index, event),
            onError: (event) => handleDeckError(index, event.data)
        }
    });
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
    } catch (_) {
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

function createPlaylistResolver() {
    playlistResolver = new YT.Player('playlistResolver', {
        height: '2',
        width: '2',
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
            onReady: () => {
                playlistResolverReady = true;
                playlistResolver.mute();
                if (pendingPlaylistResolve) beginPlaylistResolve(pendingPlaylistResolve);
            },
            onStateChange: tryReadResolvedPlaylist,
            onError: () => setTimeout(tryReadResolvedPlaylist, 100)
        }
    });
}

function onYouTubeIframeAPIReady() {
    createDeck(0);
    createDeck(1);
    createPlaylistResolver();
}

function ensureNextPreload() {
    if (!decksReady() || crossfade) return;

    const nextSong = audioState.nextSong;
    const seconds = normaliseCrossfadeSeconds(audioState.crossfadeSeconds);
    if (!nextSong || !nextSong.videoId || seconds <= 0 || audioState.locationId == null) {
        const inactive = 1 - activeDeck;
        if (decks[inactive].preload) clearDeck(inactive);
        return;
    }

    const inactive = 1 - activeDeck;
    const deck = decks[inactive];
    const nextVideoId = String(nextSong.videoId);

    if (deck.videoId === nextVideoId && Number(deck.locationId) === Number(audioState.locationId)) {
        deck.preload = true;
        setDeckVolume(inactive, 0);
        return;
    }

    clearDeck(inactive);
    deck.videoId = nextVideoId;
    deck.locationId = audioState.locationId;
    deck.preload = true;
    deck.metadataKey = null;

    try {
        deck.player.cueVideoById({ videoId: nextVideoId, startSeconds: 0 });
        setDeckVolume(inactive, 0);
    } catch (_) {
        handleDeckError(inactive, 5);
    }
}

function maybeStartCrossfade() {
    if (!decksReady() || crossfade) return;

    const seconds = normaliseCrossfadeSeconds(audioState.crossfadeSeconds);
    const nextSong = audioState.nextSong;
    if (seconds <= 0 || !nextSong || !nextSong.videoId) return;

    const from = activeDeck;
    const to = 1 - activeDeck;
    const sourceDeck = decks[from];
    const targetDeck = decks[to];

    if (!sourceDeck.videoId || !sourceDeck.player || !targetDeck.player) return;
    if (targetDeck.videoId !== String(nextSong.videoId) || Number(targetDeck.locationId) !== Number(audioState.locationId)) {
        ensureNextPreload();
        return;
    }

    let duration = 0;
    let current = 0;
    try {
        duration = Number(sourceDeck.player.getDuration()) || 0;
        current = Number(sourceDeck.player.getCurrentTime()) || 0;
    } catch (_) {
        return;
    }

    if (duration <= 0 || current <= 0) return;
    const remaining = duration - current;
    if (remaining > seconds || remaining <= 0.12) return;

    crossfade = {
        from,
        to,
        locationId: audioState.locationId,
        videoId: sourceDeck.videoId,
        nextVideoId: targetDeck.videoId,
        durationMs: Math.max(250, seconds * 1000),
        startedAt: null,
        serverAlreadyAdvanced: false
    };

    targetDeck.preload = false;
    setDeckVolume(to, 0);

    try {
        targetDeck.player.playVideo();
    } catch (_) {
        handleDeckError(to, 5);
    }
}

function applyCrossfadeVolumes() {
    if (!crossfade || crossfade.startedAt == null) return;

    const elapsed = performance.now() - crossfade.startedAt;
    const ratio = clamp(elapsed / crossfade.durationMs, 0, 1);
    const base = audioState.spatialVolume;

    setDeckVolume(crossfade.from, base * (1 - ratio));
    setDeckVolume(crossfade.to, base * ratio);

    if (ratio >= 1) finishCrossfade();
}

function finishCrossfade() {
    if (!crossfade) return;

    const finished = crossfade;
    const oldDeck = decks[finished.from];
    const newDeck = decks[finished.to];

    clearDeck(finished.from);
    activeDeck = finished.to;
    newDeck.preload = false;
    setDeckVolume(activeDeck, audioState.spatialVolume);
    crossfade = null;
    crossfadeBadge.classList.add('hidden');

    nuiPost('songEnded', {
        locationId: finished.locationId,
        videoId: finished.videoId
    });

    ensureNextPreload();
}

function playAudio(data) {
    if (!data || !data.videoId) return;

    audioState.locationId = Number(data.locationId);
    audioState.videoId = String(data.videoId);
    audioState.nextSong = data.nextSong || null;
    audioState.crossfadeSeconds = normaliseCrossfadeSeconds(data.crossfadeSeconds);
    audioState.spatialVolume = normaliseVolume(data.volume);

    if (!decksReady()) {
        pendingAudio = data;
        return;
    }

    if (
        crossfade &&
        decks[crossfade.to].videoId === audioState.videoId &&
        Number(decks[crossfade.to].locationId) === Number(audioState.locationId)
    ) {

        applyCrossfadeVolumes();
        return;
    }

    const matchingDeck = getMatchingDeck(audioState.videoId, audioState.locationId);
    if (matchingDeck !== -1 && matchingDeck !== activeDeck) {
        const oldDeck = decks[activeDeck];
        const incomingDeck = decks[matchingDeck];
        const seconds = normaliseCrossfadeSeconds(audioState.crossfadeSeconds);

        if (incomingDeck.preload && oldDeck.videoId && Number(oldDeck.locationId) === Number(audioState.locationId) && seconds > 0) {
            crossfade = {
                from: activeDeck,
                to: matchingDeck,
                locationId: audioState.locationId,
                videoId: oldDeck.videoId,
                nextVideoId: incomingDeck.videoId,
                durationMs: Math.max(250, seconds * 1000),
                startedAt: null,
                serverAlreadyAdvanced: true
            };
            incomingDeck.preload = false;
            setDeckVolume(matchingDeck, 0);
            try { incomingDeck.player.playVideo(); } catch (_) { handleDeckError(matchingDeck, 5); }
            return;
        }

        clearDeck(activeDeck);
        activeDeck = matchingDeck;
        decks[activeDeck].preload = false;
        try { decks[activeDeck].player.playVideo(); } catch (_) {}
        setDeckVolume(activeDeck, audioState.spatialVolume);
        ensureNextPreload();
        return;
    }

    const active = decks[activeDeck];
    const sameTrack = active.videoId === audioState.videoId && Number(active.locationId) === Number(audioState.locationId);

    if (!sameTrack) {
        crossfade = null;
        crossfadeBadge.classList.add('hidden');
        clearDeck(1 - activeDeck);

        active.videoId = audioState.videoId;
        active.locationId = audioState.locationId;
        active.preload = false;
        active.metadataKey = null;

        try {
            active.player.loadVideoById({
                videoId: audioState.videoId,
                startSeconds: Math.max(0, Number(data.startSeconds) || 0)
            });
            active.player.playVideo();
        } catch (_) {
            handleDeckError(activeDeck, 5);
            return;
        }
    }

    setDeckVolume(activeDeck, audioState.spatialVolume);
    scheduleMetadataReport(activeDeck);
    ensureNextPreload();
}

function updatePlaybackContext(data) {
    if (!data) return;

    setSpatialVolume(data.volume);

    if (
        data.locationId != null &&
        data.videoId &&
        Number(data.locationId) === Number(audioState.locationId) &&
        String(data.videoId) === String(audioState.videoId)
    ) {
        audioState.nextSong = data.nextSong || null;
        audioState.crossfadeSeconds = normaliseCrossfadeSeconds(data.crossfadeSeconds);
        ensureNextPreload();
    }
}

function stopAudio() {
    pendingAudio = null;
    crossfade = null;
    crossfadeBadge.classList.add('hidden');
    clearDeck(0);
    clearDeck(1);
    activeDeck = 0;
    audioState = {
        locationId: null,
        videoId: null,
        nextSong: null,
        crossfadeSeconds: 4,
        spatialVolume: 0
    };
}

function createQueueAction(label, title, className, disabled, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-action ${className || ''}`.trim();
    button.textContent = label;
    button.title = title;
    button.disabled = Boolean(disabled);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!button.disabled) handler();
    });
    return button;
}

function clearQueueDragVisuals() {
    document.body.classList.remove('queue-reordering');
    document.querySelectorAll('.queue-item.pointer-dragging, .queue-item.drag-over').forEach((el) => {
        el.classList.remove('pointer-dragging', 'drag-over');
    });
    document.querySelectorAll('.drag-handle.drag-active').forEach((el) => {
        el.classList.remove('drag-active');
    });
}

function positionDraggedQueueItem(clientY) {
    if (!queuePointerDrag || !queuePointerDrag.item) return;

    const listRect = queueList.getBoundingClientRect();
    const edgeSize = Math.min(52, Math.max(28, listRect.height * 0.12));
    if (clientY < listRect.top + edgeSize) {
        queueList.scrollTop -= 14;
    } else if (clientY > listRect.bottom - edgeSize) {
        queueList.scrollTop += 14;
    }

    const draggedItem = queuePointerDrag.item;
    const candidates = Array.from(queueList.querySelectorAll('.queue-item')).filter((item) => item !== draggedItem);
    let insertBefore = null;

    for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        if (clientY < rect.top + (rect.height / 2)) {
            insertBefore = candidate;
            break;
        }
    }

    if (insertBefore) {
        queueList.insertBefore(draggedItem, insertBefore);
    } else {
        queueList.appendChild(draggedItem);
    }
}

function finishQueuePointerDrag(cancelled = false) {
    const drag = queuePointerDrag;
    if (!drag) return;

    queuePointerDrag = null;

    try {
        if (drag.handle && drag.handle.hasPointerCapture && drag.handle.hasPointerCapture(drag.pointerId)) {
            drag.handle.releasePointerCapture(drag.pointerId);
        }
    } catch (_) {}

    clearQueueDragVisuals();

    if (cancelled) {
        renderQueue(currentQueue);
        return;
    }

    const orderedItems = Array.from(queueList.querySelectorAll('.queue-item'));
    const newIndex = orderedItems.indexOf(drag.item) + 1;

    if (newIndex > 0 && newIndex !== drag.fromIndex) {
        nuiPost('moveQueueItem', {
            fromIndex: drag.fromIndex,
            toIndex: newIndex,
            videoId: drag.videoId
        });
    }
}

function beginQueuePointerDrag(event, item, handle, index, videoId) {
    if (queuePointerDrag) finishQueuePointerDrag(true);
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    queuePointerDrag = {
        item,
        handle,
        fromIndex: index,
        videoId,
        pointerId: event.pointerId
    };

    item.classList.add('pointer-dragging');
    handle.classList.add('drag-active');
    document.body.classList.add('queue-reordering');

    try {
        if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
    } catch (_) {}
}

document.addEventListener('pointermove', (event) => {
    if (!queuePointerDrag || event.pointerId !== queuePointerDrag.pointerId) return;
    event.preventDefault();
    positionDraggedQueueItem(event.clientY);
}, { passive: false });

document.addEventListener('pointerup', (event) => {
    if (!queuePointerDrag || event.pointerId !== queuePointerDrag.pointerId) return;
    event.preventDefault();
    finishQueuePointerDrag(false);
}, { passive: false });

document.addEventListener('pointercancel', (event) => {
    if (!queuePointerDrag || event.pointerId !== queuePointerDrag.pointerId) return;
    finishQueuePointerDrag(true);
});

function renderQueue(queue = []) {
    currentQueue = Array.isArray(queue) ? queue : [];
    queueList.innerHTML = '';
    queueCount.textContent = `${currentQueue.length} ${currentQueue.length === 1 ? 'track' : 'tracks'}`;

    if (currentQueue.length === 0) {
        queueList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">♫</div>
                <strong>No songs queued</strong>
                <span>Add a YouTube video or playlist to get started.</span>
            </div>`;
        return;
    }

    currentQueue.forEach((song, zeroIndex) => {
        const index = zeroIndex + 1;
        const videoId = String((song && song.videoId) || '');

        const item = document.createElement('div');
        item.className = 'queue-item';
        item.dataset.index = String(index);
        item.dataset.videoId = videoId;

        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.textContent = '⋮⋮';
        handle.title = 'Hold and drag to reorder';
        handle.setAttribute('role', 'button');
        handle.setAttribute('aria-label', `Drag queue item ${index} to reorder`);

        const thumb = document.createElement('img');
        thumb.className = 'queue-thumb';
        thumb.alt = '';
        thumb.src = thumbnailUrl(videoId);
        thumb.onerror = () => { thumb.style.opacity = '0.2'; };

        const info = document.createElement('div');
        info.className = 'queue-track-info';

        const title = document.createElement('div');
        title.className = 'queue-track-title';
        title.textContent = cleanDisplayTitle(song);

        const sub = document.createElement('div');
        sub.className = 'queue-track-sub';
        const duration = song && song.duration ? ` • ${formatTime(song.duration)}` : '';
        sub.textContent = `${song && song.author ? song.author : `Queue #${index}`}${duration}`;

        info.append(title, sub);

        const actions = document.createElement('div');
        actions.className = 'queue-actions';
        actions.append(
            createQueueAction('Play', 'Play this track now', 'play-now', false, () => {
                nuiPost('playQueueItem', { index, videoId });
            }),
            createQueueAction('↑', 'Move up', '', index === 1, () => {
                nuiPost('moveQueueItem', { fromIndex: index, toIndex: index - 1, videoId });
            }),
            createQueueAction('↓', 'Move down', '', index === currentQueue.length, () => {
                nuiPost('moveQueueItem', { fromIndex: index, toIndex: index + 1, videoId });
            }),
            createQueueAction('×', 'Remove from queue', 'remove', false, () => {
                nuiPost('removeQueueItem', { index, videoId });
            })
        );

        item.append(handle, thumb, info, actions);

        handle.addEventListener('pointerdown', (event) => {
            beginQueuePointerDrag(event, item, handle, index, videoId);
        });

        queueList.appendChild(item);
    });
}

function updateNowPlaying(song) {
    const hasSong = song && song.videoId;
    nowPlaying.textContent = hasSong ? cleanDisplayTitle(song) : 'Nothing playing';
    nowAuthor.textContent = hasSong ? (song.author || 'YouTube') : 'Waiting for a track';
    videoIdLabel.textContent = hasSong ? `YouTube • ${song.videoId}` : 'No video loaded';

    if (hasSong) {
        nowArtwork.src = thumbnailUrl(song.videoId);
        nowArtwork.style.display = 'block';
        artworkFallback.style.display = 'none';
        nowArtwork.onerror = () => {
            nowArtwork.style.display = 'none';
            artworkFallback.style.display = 'grid';
        };
    } else {
        nowArtwork.removeAttribute('src');
        nowArtwork.style.display = 'none';
        artworkFallback.style.display = 'grid';
    }
}

function updateBoothUI(data) {
    uiLocationId = data.locationId != null ? Number(data.locationId) : uiLocationId;
    latestBoothData = {
        ...data,
        receivedAtMs: performance.now()
    };

    locationName.textContent = data.location || 'DJ Booth';
    updateNowPlaying(data.currentSong);
    renderQueue(data.queue || []);
    updateVolumeSlider(data.boothVolume);

    const seconds = normaliseCrossfadeSeconds(data.crossfadeSeconds);
    crossfadeInfo.textContent = seconds > 0 ? `${seconds.toFixed(seconds % 1 ? 1 : 0)}s crossfade` : 'Crossfade off';
    updateProgressUI();
}

function getLocalProgressForSelectedSong(song) {
    if (!song || !song.videoId || uiLocationId == null) return null;
    const matching = getMatchingDeck(String(song.videoId), Number(uiLocationId));
    if (matching === -1) return null;

    const deck = decks[matching];
    if (!deck.ready || !deck.player) return null;

    try {
        return {
            current: Number(deck.player.getCurrentTime()) || 0,
            duration: Number(deck.player.getDuration()) || Number(song.duration) || 0
        };
    } catch (_) {
        return null;
    }
}

function updateProgressUI() {
    const data = latestBoothData;
    const song = data && data.currentSong;
    if (!data || !song || !data.isPlaying) {
        progressBar.style.width = '0%';
        elapsedTime.textContent = '0:00';
        durationTime.textContent = song && song.duration ? formatTime(song.duration) : '0:00';
        return;
    }

    const local = getLocalProgressForSelectedSong(song);
    const duration = local ? local.duration : (Number(song.duration) || 0);
    const fallbackElapsed = Math.max(0, Number(data.elapsed) || 0) + Math.max(0, (performance.now() - data.receivedAtMs) / 1000);
    const current = local ? local.current : fallbackElapsed;
    const safeCurrent = duration > 0 ? Math.min(current, duration) : current;
    const percent = duration > 0 ? clamp((safeCurrent / duration) * 100, 0, 100) : 0;

    progressBar.style.width = `${percent}%`;
    elapsedTime.textContent = formatTime(safeCurrent);
    durationTime.textContent = duration > 0 ? formatTime(duration) : '--:--';

    const selectedCrossfadeActive = crossfade && Number(crossfade.locationId) === Number(uiLocationId) && crossfade.startedAt != null;
    crossfadeBadge.classList.toggle('hidden', !selectedCrossfadeActive);
}

function submitYouTubeLink() {
    const url = urlInput.value.trim();
    if (!url) return;

    showStatus('Adding to queue...', 'info');
    nuiPost('addSong', { url });
    urlInput.value = '';
}

function postBoothVolume() {
    nuiPost('setBoothVolume', {
        volume: Number(volumeSlider.value) / 100
    });
}

function queueBoothVolumePost() {
    if (volumePostTimer) clearTimeout(volumePostTimer);
    volumePostTimer = setTimeout(postBoothVolume, 100);
}

closeBtn.addEventListener('click', () => nuiPost('closeUI'));
addBtn.addEventListener('click', submitYouTubeLink);

urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitYouTubeLink();
    }
});

volumeSlider.addEventListener('input', () => {
    const volume = Number(volumeSlider.value) / 100;
    updateVolumeSlider(volume);
    queueBoothVolumePost();
});

volumeSlider.addEventListener('change', postBoothVolume);
skipBtn.addEventListener('click', () => nuiPost('skipSong'));
stopBtn.addEventListener('click', () => nuiPost('stopSong'));
refreshBtn.addEventListener('click', () => nuiPost('requestQueue'));

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') nuiPost('closeUI');
});

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.action) return;

    switch (data.action) {
        case 'openUI':
            app.classList.remove('hidden');
            break;
        case 'closeUI':
            app.classList.add('hidden');
            break;
        case 'updateBooth':
            updateBoothUI(data);
            break;
        case 'playlistStatus':
            showStatus(data.message, data.statusType || 'info');
            break;
        case 'resolvePlaylist':
            showStatus('Reading YouTube playlist...', 'info');
            beginPlaylistResolve(data);
            break;
        case 'playAudio':
            playAudio(data);
            break;
        case 'setAudioVolume':
            updatePlaybackContext(data);
            break;
        case 'stopAudio':
            stopAudio();
            break;
        default:
            break;
    }
});

setInterval(() => {
    if (crossfade && crossfade.startedAt != null) {
        applyCrossfadeVolumes();
    } else {
        maybeStartCrossfade();
    }

    ensureNextPreload();
    reportDeckMetadata(activeDeck);
    updateProgressUI();
}, 200);
