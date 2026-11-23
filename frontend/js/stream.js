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
const chatConnectionStatus = document.getElementById("chatConnectionStatus");
const chatMessages = document.getElementById("chatMessages");
const chatFeedback = document.getElementById("chatFeedback");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

let room = null;
let roomDetails = null;
let cameraEnabled = false;
let microphoneEnabled = false;
let screenShareEnabled = false;
let roomConnected = false;
let roomIsLive = false;
let endingRoom = false;
let chatSocket = null;
let chatReconnectTimer = null;
let chatReconnectAttempts = 0;
let chatStopped = false;
const chatMessageIds = new Set();

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

function setChatStatus(message, state) {
    chatConnectionStatus.textContent = message;
    chatConnectionStatus.dataset.state = state;
}

function showChatFeedback(message, isError = false) {
    chatFeedback.textContent = message;
    chatFeedback.classList.toggle("error", isError);
}

function setChatInputEnabled(enabled) {
    chatInput.disabled = !enabled;
    chatSendBtn.disabled = !enabled;
}

function renderChatMessage(message) {
    const messageId = Number(message.id);
    if (
        !Number.isSafeInteger(messageId)
        || chatMessageIds.has(messageId)
        || typeof message.username !== "string"
        || typeof message.content !== "string"
    ) {
        return;
    }

    chatMessageIds.add(messageId);

    const item = document.createElement("li");
    item.className = "chat-message";
    item.dataset.messageId = String(messageId);

    const header = document.createElement("div");
    header.className = "chat-message-header";
    const username = document.createElement("span");
    username.className = "chat-message-username";
    username.textContent = message.username;

    const timestamp = document.createElement("time");
    timestamp.className = "chat-message-time";
    const createdAt = Number(message.created_at);
    if (Number.isFinite(createdAt)) {
        timestamp.dateTime = new Date(createdAt * 1000).toISOString();
        timestamp.textContent = new Date(createdAt * 1000)
            .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    header.append(username, timestamp);

    const content = document.createElement("p");
    content.className = "chat-message-content";
    content.textContent = message.content;
    item.append(header, content);

    const nextMessage = [...chatMessages.children].find(
        (existing) => Number(existing.dataset.messageId) > messageId
    );
    chatMessages.insertBefore(item, nextMessage || null);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function loadChatHistory() {
    try {
        const messages = await requestJson(
            `/api/rooms/${roomId}/messages?limit=50`
        );
        messages.forEach(renderChatMessage);
    } catch (error) {
        showChatFeedback(error.message, true);
    }
}

function stopChat(message) {
    chatStopped = true;
    clearTimeout(chatReconnectTimer);
    chatReconnectTimer = null;
    setChatInputEnabled(false);
    setChatStatus(message, "ended");
    if (chatSocket && chatSocket.readyState < WebSocket.CLOSING) {
        chatSocket.close();
    }
    chatSocket = null;
}

function scheduleChatReconnect() {
    if (chatStopped || !roomIsLive || chatReconnectTimer) {
        return;
    }

    const delay = Math.min(1000 * (2 ** chatReconnectAttempts), 30000);
    chatReconnectAttempts += 1;
    setChatStatus("Connection lost. Reconnecting...", "reconnecting");
    chatReconnectTimer = window.setTimeout(() => {
        chatReconnectTimer = null;
        connectChat();
    }, delay);
}

function connectChat() {
    if (!roomIsLive || chatStopped) {
        return;
    }
    if (
        chatSocket
        && chatSocket.readyState <= WebSocket.OPEN
    ) {
        return;
    }

    const socketUrl = new URL(`/ws/streams/${roomId}`, window.location.href);
    socketUrl.protocol = window.location.protocol === "https:"
        ? "wss:"
        : "ws:";
    setChatStatus("Connecting to chat...", "connecting");

    const socket = new WebSocket(socketUrl);
    chatSocket = socket;
    socket.addEventListener("open", () => {
        if (chatSocket !== socket) {
            return;
        }
        chatReconnectAttempts = 0;
        setChatStatus("Connected", "connected");
        setChatInputEnabled(true);
        showChatFeedback("");
        loadChatHistory();
    });
    socket.addEventListener("message", (event) => {
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch {
            showChatFeedback("Received an invalid chat event.", true);
            return;
        }

        if (payload.type === "chat.message") {
            renderChatMessage(payload);
        } else if (payload.type === "stream.ended") {
            stopChat("This stream has ended.");
        } else if (payload.type === "error") {
            showChatFeedback(payload.message, true);
        }
    });
    socket.addEventListener("close", (event) => {
        if (chatSocket === socket) {
            chatSocket = null;
        }
        setChatInputEnabled(false);
        if (event.code === 4401) {
            chatStopped = true;
            clearTimeout(chatReconnectTimer);
            setChatStatus("Session expired. Redirecting to login...", "ended");
            window.location.replace("/login");
            return;
        }
        if (event.code === 4409) {
            stopChat("This stream has ended.");
            return;
        }
        scheduleChatReconnect();
    });
}

function sendChatMessage(event) {
    event.preventDefault();
    const content = chatInput.value.trim();
    if (!content) {
        return;
    }
    if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) {
        showChatFeedback("Chat is reconnecting. Please try again.", true);
        return;
    }

    chatSocket.send(JSON.stringify({
        type: "chat.send",
        content
    }));
    chatInput.value = "";
    showChatFeedback("");
}

function removeTrack(track) {
    for (const element of track.detach()) {
        element.remove();
    }
}

function removeTrackElements(participant, source) {
    const participantSelector = CSS.escape(participant.identity);
    const sourceSelector = CSS.escape(String(source));
    const selector =
        `[data-participant="${participantSelector}"][data-source="${sourceSelector}"]`;

    videoStage.querySelectorAll(selector).forEach((element) => {
        element.remove();
    });
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
    element.muted = isLocal;
    videoPlaceholder.hidden = true;
    videoStage.append(element);
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
    setChatStatus("Stream is live. Connecting to chat...", "connecting");
    connectChat();
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
        })
        .on(LivekitClient.RoomEvent.LocalTrackUnpublished, (publication, participant) => {
            if (publication.track) {
                removeTrack(publication.track);
            }
            removeTrackElements(participant, publication.source);
            updateVideoPlaceholder();

            if (publication.source === LivekitClient.Track.Source.ScreenShare) {
                screenShareEnabled = false;
                screenShareBtn.textContent = "Share screen";
                showMessage(
                    "Screen sharing stopped. The live room is still open; you can share again."
                );
            }
            if (publication.source === LivekitClient.Track.Source.Camera) {
                cameraEnabled = false;
                cameraBtn.textContent = "Turn camera on";
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
    roomIsLive = roomDetails.status === "live";
    connectBtn.textContent = roomDetails.role === "host"
        ? "Connect as host"
        : "Join stream";
    connectBtn.disabled = false;
    await loadChatHistory();

    if (roomIsLive) {
        connectChat();
    } else if (roomDetails.role === "host") {
        setChatStatus("Chat opens when the stream goes live.", "waiting");
        setStatus("Room ready", "ready");
    } else {
        setStatus("Live", "live");
    }
}

async function connectToRoom() {
    if (!window.LivekitClient) {
        setStatus("SDK unavailable", "error");
        showMessage(
            "Unable to load LiveKit. Check your internet connection.",
            true
        );
        connectBtn.disabled = true;
        return;
    }

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
            showMessage(
                "Screen sharing stopped. The live room is still open; you can share again."
            );
            return;
        }

        await room.localParticipant.setScreenShareEnabled(true, {
            audio: true
        });
        screenShareEnabled = true;
        screenShareBtn.textContent = "Stop sharing";
        await markRoomLive();
        showMessage(
            "For shared audio, choose a browser tab and enable its audio-sharing option."
        );
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
        stopChat("This stream has ended.");
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
chatForm.addEventListener("submit", sendChatMessage);
window.addEventListener("pagehide", () => {
    chatStopped = true;
    clearTimeout(chatReconnectTimer);
    chatSocket?.close();
});

loadRoom()
    .then(() => {
        if (!window.LivekitClient) {
            setStatus("SDK unavailable", "error");
            showMessage(
                "Unable to load LiveKit. Check your internet connection.",
                true
            );
            connectBtn.disabled = true;
        }
    })
    .catch((error) => {
        setStatus("Unable to open room", "error");
        showMessage(error.message, true);
    });
