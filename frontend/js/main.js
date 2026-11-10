async function checkBackend() {
    const statusElement =
        document.getElementById("serverStatus");

    try {
        const response = await fetch("/api/status");

        if (!response.ok) {
            throw new Error("Backend request failed");
        }

        const data = await response.json();

        statusElement.textContent = data.message;

    } catch (error) {
        statusElement.textContent =
            "Cannot connect to backend";

        statusElement.style.color = "red";

        console.error(error);
    }
}

document.getElementById("loginBtn").onclick = () => {
    alert("Login system will be implemented next.");
};

document.getElementById("registerBtn").onclick = () => {
    alert("Registration system will be implemented next.");
};

document.getElementById("startStreamBtn").onclick = () => {
    alert("Streaming system will be implemented later.");
};

checkBackend();