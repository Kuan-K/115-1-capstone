
let currentUser = null;

const accountArea = document.getElementById("accountArea");
const startStreamBtn = document.getElementById("startStreamBtn");

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

    } catch (error) {
        console.error("Login status error:", error);
        currentUser = null;
        showGuestHeader();
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

// ========== Streaming Entry ==========

startStreamBtn.addEventListener("click", () => {
    if (!currentUser) {
        window.location.href = "/login";
        return;
    }

    alert("Streaming feature is coming next.");
});

// ========== Initialize ==========

checkBackend();
checkLogin();
