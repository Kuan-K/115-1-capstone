let currentUser = null;

const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const startStreamBtn = document.getElementById("startStreamBtn");


// ========== Check backend ==========

async function checkBackend() {
    const status = document.getElementById("serverStatus");

    try {
        const response = await fetch("/api/status");

        if (!response.ok) {
            throw new Error("Backend unavailable");
        }

        const data = await response.json();

        status.textContent = data.message;

    } catch (error) {
        status.textContent = "Cannot connect to backend";
        status.style.color = "#f87171";
    }
}


// ========== Check current user ==========

async function checkLogin() {
    const status = document.getElementById("authStatus");

    try {
        const response = await fetch("/api/auth/me");

        if (!response.ok) {
            currentUser = null;
            throw new Error("Not logged in");
        }

        currentUser = await response.json();

        status.textContent =
            "Logged in as: " + currentUser.username;

        loginBtn.textContent = "Logout";
        registerBtn.hidden = true;

        loginBtn.onclick = logout;

    } catch (error) {
        status.textContent = "You are not logged in.";

        loginBtn.textContent = "Login";
        registerBtn.hidden = false;

        loginBtn.onclick = () => {
            window.location.href = "/auth";
        };

        registerBtn.onclick = () => {
            window.location.href = "/auth";
        };
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
        await checkLogin();

    } catch (error) {
        alert("Logout failed. Please try again.");
    }
}


// ========== Start streaming ==========

startStreamBtn.onclick = () => {
    if (!currentUser) {
        window.location.href = "/auth";
        return;
    }

    alert("Streaming feature will be implemented next.");
};


// ========== Initialize ==========

checkBackend();
checkLogin();
