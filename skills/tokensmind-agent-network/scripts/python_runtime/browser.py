import webbrowser


class BrowserOpener:
    def __init__(self, open_impl=webbrowser.open):
        self._open_impl = open_impl

    def open(self, url):
        if not self._open_impl(url, new=2):
            raise RuntimeError("Unable to open the TokensMind authorization page")


class ReportingBrowser:
    def __init__(self, browser, write_event):
        self._browser = browser
        self._write_event = write_event

    def open(self, url):
        try:
            self._browser.open(url)
            self._write_event({"event": "authorization_opened", "verificationUrl": url})
        except Exception:
            self._write_event({
                "event": "authorization_required",
                "verificationUrl": url,
                "message": "Open this URL to approve the pending Agent Network connection.",
            })
