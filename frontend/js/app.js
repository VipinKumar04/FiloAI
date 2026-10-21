const checkButton = document.querySelector("#check-backend");
const connectionStatus = document.querySelector("#connection-status");

async function checkBackend() {
  checkButton.disabled = true;
  connectionStatus.dataset.state = "loading";
  connectionStatus.textContent = "Checking backend…";

  try {
    const response = await fetch("/api/health", {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Backend returned HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.success !== true) {
      throw new Error("Unexpected health response.");
    }

    connectionStatus.dataset.state = "success";
    connectionStatus.textContent = "Backend connected";
  } catch (error) {
    connectionStatus.dataset.state = "error";
    connectionStatus.textContent = "Backend unavailable";
    console.error("filoAI health check failed:", error.message);
  } finally {
    checkButton.disabled = false;
  }
}

checkButton.addEventListener("click", checkBackend);
checkBackend();
