/**
 * First-run page. Shown once, on install.
 */

document.querySelector("#openSettings").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
});

document.querySelector("#close").addEventListener("click", () => {
    // Closing our own tab needs no tabs permission; the page owns itself.
    window.close();
});
