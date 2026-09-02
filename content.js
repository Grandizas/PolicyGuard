browser.runtime.onMessage.addListener((message) => {

    if (message.type === "ANALYZE_PAGE") {

        const text = document.body.innerText;

        return Promise.resolve({
            text: text
        });
    }

});
