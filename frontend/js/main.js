
let currentUser = null;

const accountArea = document.getElementById("accountArea");
const startStreamBtn = document.getElementById("startStreamBtn");
const createRoomForm = document.getElementById("createRoomForm");
const roomTitle = document.getElementById("roomTitle");
const roomFeedback = document.getElementById("roomFeedback");
const roomList = document.getElementById("roomList");
const roomsMessage = document.getElementById("roomsMessage");
const liveRooms = document.getElementById("liveRooms");
const refreshRoomsBtn = document.getElementById("refreshRoomsBtn");

// Create an anchor element
function createLink(text, href, className) {
    const link = document.createElement("a");
    link.textContent = text;
    link.href = href;
    link.className = className;
    return link;
}

// ========== Guest Header ==========

function showGuestHeader() {
    const loginLink = createLink(
        "Login", "/login", "nav-link"
    );

    const registerLink = createLink(
        "Register", "/register", "btn btn-small"
    );

    accountArea.replaceChildren(loginLink, registerLink);
}

// ========== Logged-in Header ==========

function showUserHeader(user) {
    const profile = document.createElement("div");
    profile.className = "user-profile";

    // Default circular avatar
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");

    // Username returned by FastAPI
    const username = document.createElement("span");
    username.className = "username";
    username.textContent = user.username;

    profile.append(avatar, username);

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "btn btn-outline btn-small";
    logoutBtn.textContent = "Logout";
    logoutBtn.addEventListener("click", logout);

    accountArea.replaceChildren(profile, logoutBtn);
}

// ========== Check Login ==========

async function checkLogin() {
    try {
        const response = await fetch("/api/auth/me", {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (!response.ok) {
            currentUser = null;
            showGuestHeader();
            return;
        }

        currentUser = await response.json();
        showUserHeader(currentUser);
        liveRooms.hidden = false;
        await loadLiveRooms();

    } catch (error) {
        console.error("Login status error:", error);
        currentUser = null;
        showGuestHeader();
        liveRooms.hidden = true;
    }
}

async function requestJson(path, options = {}) {
    const response = await fetch(path, {
        credentials: "same-origin",
        ...options
    });
    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            typeof data.detail === "string"
                ? data.detail
                : "Request failed"
        );
    }

    return data;
}

async function loadLiveRooms() {
    roomsMessage.textContent = "Loading live streams...";
    roomList.replaceChildren();

    try {
        const rooms = await requestJson("/api/rooms");
        roomsMessage.textContent = rooms.length
            ? ""
            : "No live streams right now.";

        for (const room of rooms) {
            const card = document.createElement("article");
            card.className = "room-card";

            const title = document.createElement("h3");
            title.textContent = room.title;

            const host = document.createElement("p");
            host.textContent = `Streaming by ${room.host_username}`;

            const watchButton = document.createElement("a");
            watchButton.className = "btn btn-primary btn-small";
            watchButton.href = `/stream/${room.id}`;
            watchButton.textContent = "Watch";

            card.append(title, host, watchButton);
            roomList.append(card);
        }
    } catch (error) {
        roomsMessage.textContent = error.message;
    }
}

// ========== Logout ==========

async function logout() {
    try {
        const response = await fetch("/api/auth/logout", {
            method: "POST",
            headers: {
                "X-Requested-With": "XMLHttpRequest"
            },
            credentials: "same-origin"
        });

        if (!response.ok) {
            throw new Error("Logout failed");
        }

        currentUser = null;
        showGuestHeader();

    } catch (error) {
        alert("Unable to logout. Please try again.");
    }
}

// ========== Backend Status ==========

async function checkBackend() {
    const status = document.getElementById("serverStatus");

    try {
        const response = await fetch("/api/status");

        if (!response.ok) {
            throw new Error("Server unavailable");
        }

        status.textContent = "Server Online";

    } catch (error) {
        status.textContent = "Server Offline";
    }
}

// ========== Registration Success ==========

const params = new URLSearchParams(window.location.search);

if (params.get("registered") === "1") {
    const message = document.getElementById("flashMessage");
    message.textContent =
        "Account created successfully! Please login.";
    message.hidden = false;

    window.history.replaceState(null, "", "/");
}

// ========== Stream room creation ==========

startStreamBtn.addEventListener("click", async () => {
    await loginCheck;
    if (!currentUser) {
        window.location.href = "/login";
        return;
    }

    createRoomForm.hidden = false;
    roomTitle.focus();
});

createRoomForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = document.getElementById("createRoomSubmit");
    submitButton.disabled = true;
    roomFeedback.textContent = "";
    roomFeedback.classList.remove("error");

    try {
        const room = await requestJson("/api/rooms", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest"
            },
            body: JSON.stringify({ title: roomTitle.value })
        });
        window.location.href = `/stream/${room.id}`;
    } catch (error) {
        roomFeedback.textContent = error.message;
        roomFeedback.classList.add("error");
        submitButton.disabled = false;
    }
});

// ========== Initialize ==========

refreshRoomsBtn.addEventListener("click", loadLiveRooms);
checkBackend();
const loginCheck = checkLogin();
