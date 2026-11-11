
const form = document.querySelector("form[data-mode]");
const feedback = document.getElementById("feedback");

async function sendAuthRequest(path, username, password) {
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "same-origin",
        body: JSON.stringify({ username, password })
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

if (form) {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const mode = form.dataset.mode;
        const username =
            document.getElementById("username").value.trim();
        const password =
            document.getElementById("password").value;

        const submitButton =
            form.querySelector('button[type="submit"]');

        feedback.textContent = "";
        submitButton.disabled = true;

        try {
            if (mode === "register") {
                const confirmPassword =
                    document.getElementById(
                        "confirmPassword"
                    ).value;

                if (password !== confirmPassword) {
                    throw new Error(
                        "Passwords do not match."
                    );
                }

                await sendAuthRequest(
                    "/api/auth/register",
                    username,
                    password
                );

                // Registration succeeded.
                // Return home without automatically logging in.
                window.location.replace("/?registered=1");

            } else if (mode === "login") {
                await sendAuthRequest(
                    "/api/auth/login",
                    username,
                    password
                );

                // Login succeeded.
                window.location.replace("/");
            }

        } catch (error) {
            feedback.textContent = error.message;
            feedback.classList.add("error");
            submitButton.disabled = false;
        }
    });
}
