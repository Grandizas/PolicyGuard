const button = document.querySelector("#analyze");
const status = document.querySelector("#status");

button.addEventListener("click", async () => {

    status.textContent = "Analyzing...";

    const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true
    });

    const tab = tabs[0];

    const response = await browser.tabs.sendMessage(
        tab.id,
        {
            type: "ANALYZE_PAGE"
        }
    );

    const text = response.text.toLowerCase();

    if (
        text.includes("terms of service") ||
        text.includes("privacy policy") ||
        text.includes("terms and conditions")
    ) {
        status.textContent =
            "This page appears to contain legal terms.";
    } else {
        status.textContent =
            "No obvious Terms or Privacy Policy detected.";
    }

});
