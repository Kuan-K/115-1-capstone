
async function sendAuthRequest(path, username, password) {
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "same-origin",
        body: JSON.stringify({
            username: username,
            password: password
        })
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


// ========== Registration ==========

document.getElementById("registerForm")
    .addEventListener("submit", async (event) => {

        event.preventDefault();

        const username = document.getElementById(
            "registerUsername"
        ).value;

        const password = document.getElementById(
            "registerPassword"
        ).value;

        const message = document.getElementById(
            "registerMessage"
        );

        try {
            const data = await sendAuthRequest(
                "/api/auth/register",
                username,
                password
            );

            message.textContent = data.message;
            message.style.color = "#4ade80";

            document.getElementById(
                "registerForm"
            ).reset();

            document.getElementById(
                "loginUsername"
            ).value = username;

        } catch (error) {
            message.textContent = error.message;
            message.style.color = "#f87171";
        }
    });


// ========== Login ==========

document.getElementById("loginForm")
    .addEventListener("submit", async (event) => {

        event.preventDefault();

        const username = document.getElementById(
            "loginUsername"
        ).value;

        const password = document.getElementById(
            "loginPassword"
        ).value;

        const message = document.getElementById(
            "loginMessage"
        );

        try {
            await sendAuthRequest(
                "/api/auth/login",
                username,
                password
            );

            // Login successful: return to homepage.
            window.location.href = "/";

        } catch (error) {
            message.textContent = error.message;
            message.style.color = "#f87171";
        }
    });