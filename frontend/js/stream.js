const roomId = window.location.pathname.split("/").pop();
const streamTitle = document.getElementById("streamTitle");
const streamHost = document.getElementById("streamHost");
const streamRole = document.getElementById("streamRole");
const streamStatus = document.getElementById("streamStatus");
const streamMessage = document.getElementById("streamMessage");
const videoStage = document.getElementById("videoStage");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const connectBtn = document.getElementById("connectBtn");
const screenShareBtn = document.getElementById("screenShareBtn");
const cameraBtn = document.getElementById("cameraBtn");
const microphoneBtn = document.getElementById("microphoneBtn");
const endStreamBtn = document.getElementById("endStreamBtn");

let room = null;
let roomDetails = null;
let cameraEnabled = false;
let microphoneEnabled = false;
let screenShareEnabled = false;
let roomConnected = false;
let roomIsLive = false;
let endingRoom = false;

async function requestJson(path, options = {}) {
    const response = await fetch(path, {
        credentials: "same-origin",
        ...options
    });
    const data = await response.json();

    if (!response.ok) {
        if (response.status === 401) {
            window.location.replace("/login");
        }
        throw new Error(
            typeof data.detail === "string"
                ? data.detail
                : "Request failed"
        );
    }

    return data;
}

function setStatus(message, state) {
    streamStatus.textContent = message;
    streamStatus.dataset.state = state;
}

function showMessage(message, isError = false) {
    streamMessage.textContent = message;
    streamMessage.classList.toggle("error", isError);
}

function removeTrack(track) {
    for (const element of track.detach()) {
        element.remove();
    }
}

function attachTrack(track, participant, isLocal = false) {
    const source = track.source;
    const participantSelector = CSS.escape(participant.identity);
    const sourceSelector = CSS.escape(String(source));
    if (videoStage.querySelector(
        `[data-participant="${participantSelector}"][data-source="${sourceSelector}"]`
    )) {
        return;
    }

    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    element.dataset.participant = participant.identity;
    element.dataset.source = source;
    if (isLocal && element instanceof HTMLVideoElement) {
        element.muted = true;
    }
    videoPlaceholder.hidden = true;
    videoStage.append(element);
}

function hasPublishedVideo() {
    return [
        LivekitClient.Track.Source.Camera,
        LivekitClient.Track.Source.ScreenShare
    ].some((source) => {
        const publication = room.localParticipant.getTrackPublication(source);
        return Boolean(publication?.track);
    });
}

async function markRoomLive() {
    if (roomIsLive) {
        return;
    }

    await requestJson(`/api/rooms/${roomId}/start`, {
        method: "POST",
        headers: {
            "X-Requested-With": "XMLHttpRequest"
        }
    });
    roomIsLive = true;
    endStreamBtn.hidden = false;
    setStatus("Live", "live");
    showMessage("You are live. Share this room with your viewers.");
}

async function endRoomIfNoVideo() {
    if (
        roomDetails?.role === "host" &&
        roomIsLive &&
        roomConnected &&
        !endingRoom &&
        !hasPublishedVideo()
    ) {
        await endStream("Video sharing stopped. The stream has ended.");
    }
}

function updateVideoPlaceholder() {
    videoPlaceholder.hidden = videoStage.querySelector("video") !== null;
}

function setupRoomEvents() {
    room
        .on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            attachTrack(track, participant);
        })
        .on(LivekitClient.RoomEvent.LocalTrackPublished, (publication, participant) => {
            if (publication.track) {
                attachTrack(publication.track, participant, true);
            }
        })
        .on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
            removeTrack(track);
            updateVideoPlaceholder();
        })
        .on(LivekitClient.RoomEvent.TrackUnpublished, (publication, participant) => {
            if (publication.track) {
                removeTrack(publication.track);
            }
            updateVideoPlaceholder();

            if (participant === room.localParticipant) {
                if (publication.source === LivekitClient.Track.Source.ScreenShare) {
                    screenShareEnabled = false;
                    screenShareBtn.textContent = "Share screen";
                }
                if (publication.source === LivekitClient.Track.Source.Camera) {
                    cameraEnabled = false;
                    cameraBtn.textContent = "Turn camera on";
                }
                endRoomIfNoVideo().catch((error) => {
                    showMessage(error.message, true);
                });
            }
        })
        .on(LivekitClient.RoomEvent.Disconnected, () => {
            roomConnected = false;
            if (!endingRoom) {
                setStatus("Disconnected", "disconnected");
                connectBtn.hidden = false;
                connectBtn.disabled = false;
                connectBtn.textContent = "Reconnect";
                screenShareBtn.hidden = true;
                cameraBtn.hidden = true;
                microphoneBtn.hidden = true;
                if (roomDetails?.role === "host") {
                    showMessage(
                        "Connection lost. The room remains listed until you end it."
                    );
                }
            }
        });
}

async function loadRoom() {
    if (!/^\d+$/.test(roomId)) {
        throw new Error("Invalid room ID");
    }

    roomDetails = await requestJson(`/api/rooms/${roomId}`);
    streamTitle.textContent = roomDetails.title;
    streamHost.textContent = `Streaming by ${roomDetails.host_username}`;
    streamRole.textContent = roomDetails.role === "host"
        ? "YOU ARE THE HOST"
        : "LIVE STREAM";
    connectBtn.textContent = roomDetails.role === "host"
        ? "Connect as host"
        : "Join stream";
    connectBtn.disabled = false;

    if (roomDetails.role === "host") {
        setStatus("Room ready", "ready");
    } else {
        setStatus("Live", "live");
    }
}

async function connectToRoom() {
    connectBtn.disabled = true;
    showMessage("");

    try {
        const credentials = await requestJson(
            `/api/rooms/${roomId}/token`,
            {
                method: "POST",
                headers: {
                    "X-Requested-With": "XMLHttpRequest"
                }
            }
        );

        room = new LivekitClient.Room({
            adaptiveStream: true,
            dynacast: true
        });
        setupRoomEvents();
        setStatus("Connecting...", "connecting");
        await room.connect(credentials.server_url, credentials.token);

        if (credentials.role === "host") {
            roomConnected = true;
            screenShareBtn.hidden = false;
            cameraBtn.hidden = false;
            microphoneBtn.hidden = false;
            endStreamBtn.hidden = false;
            setStatus("Connected", "ready");
            showMessage(
                "Share your screen or turn on your camera to start the live stream."
            );
        } else {
            setStatus("Live", "live");
        }

        connectBtn.hidden = true;
    } catch (error) {
        if (room) {
            await room.disconnect();
            room = null;
        }
        setStatus("Not connected", "error");
        showMessage(error.message, true);
        connectBtn.disabled = false;
        if (roomDetails?.role === "host") {
            setStatus("Room ready", "ready");
        }
    }
}

async function toggleScreenShare() {
    if (!room || !roomConnected) {
        return;
    }

    screenShareBtn.disabled = true;
    showMessage("");

    try {
        if (screenShareEnabled) {
            await room.localParticipant.setScreenShareEnabled(false);
            screenShareEnabled = false;
            screenShareBtn.textContent = "Share screen";
            await endRoomIfNoVideo();
            return;
        }

        await room.localParticipant.setScreenShareEnabled(true);
        screenShareEnabled = true;
        screenShareBtn.textContent = "Stop sharing";
        await markRoomLive();
    } catch (error) {
        screenShareEnabled = Boolean(
            room.localParticipant.getTrackPublication(
                LivekitClient.Track.Source.ScreenShare
            )?.track
        );
        screenShareBtn.textContent = screenShareEnabled
            ? "Stop sharing"
            : "Share screen";
        showMessage(error.message, true);
    } finally {
        screenShareBtn.disabled = false;
    }
}

async function toggleCamera() {
    if (!room || !roomConnected) {
        return;
    }

    cameraBtn.disabled = true;
    try {
        if (cameraEnabled) {
            await room.localParticipant.setCameraEnabled(false);
            cameraEnabled = false;
            cameraBtn.textContent = "Turn camera on";
            await endRoomIfNoVideo();
        } else {
            await room.localParticipant.setCameraEnabled(true);
            cameraEnabled = true;
            cameraBtn.textContent = "Turn camera off";
            await markRoomLive();
        }
    } catch (error) {
        cameraEnabled = Boolean(
            room.localParticipant.getTrackPublication(
                LivekitClient.Track.Source.Camera
            )?.track
        );
        cameraBtn.textContent = cameraEnabled
            ? "Turn camera off"
            : "Turn camera on";
        showMessage(error.message, true);
    } finally {
        cameraBtn.disabled = false;
    }
}

async function toggleMicrophone() {
    if (!room || !roomConnected) {
        return;
    }

    microphoneBtn.disabled = true;
    try {
        const nextEnabled = !microphoneEnabled;
        await room.localParticipant.setMicrophoneEnabled(nextEnabled);
        microphoneEnabled = nextEnabled;
        microphoneBtn.textContent = microphoneEnabled
            ? "Mute microphone"
            : "Enable microphone";
    } catch (error) {
        showMessage(error.message, true);
    } finally {
        microphoneBtn.disabled = false;
    }
}

async function endStream(message = "Your stream has ended.") {
    if (endingRoom) {
        return;
    }

    endingRoom = true;
    endStreamBtn.disabled = true;

    try {
        await requestJson(`/api/rooms/${roomId}/end`, {
            method: "POST",
            headers: {
                "X-Requested-With": "XMLHttpRequest"
            }
        });
        await room?.disconnect();
        room = null;
        roomConnected = false;
        roomIsLive = false;
        setStatus("Ended", "ended");
        showMessage(message);
        connectBtn.hidden = true;
        screenShareBtn.hidden = true;
        cameraBtn.hidden = true;
        microphoneBtn.hidden = true;
        endStreamBtn.hidden = true;
        for (const element of videoStage.querySelectorAll("video, audio")) {
            element.remove();
        }
        videoPlaceholder.hidden = false;
        videoPlaceholder.textContent = "This stream has ended.";
    } catch (error) {
        endingRoom = false;
        endStreamBtn.disabled = false;
        showMessage(error.message, true);
    }
}

connectBtn.addEventListener("click", connectToRoom);
screenShareBtn.addEventListener("click", toggleScreenShare);
cameraBtn.addEventListener("click", () => {
    toggleCamera().catch((error) => showMessage(error.message, true));
});
microphoneBtn.addEventListener("click", () => {
    toggleMicrophone().catch((error) => showMessage(error.message, true));
});
endStreamBtn.addEventListener("click", () => endStream());

if (!window.LivekitClient) {
    setStatus("SDK unavailable", "error");
    showMessage("Unable to load LiveKit. Check your internet connection.", true);
    connectBtn.disabled = true;
} else {
    loadRoom().catch((error) => {
        setStatus("Unable to open room", "error");
        showMessage(error.message, true);
    });
}
