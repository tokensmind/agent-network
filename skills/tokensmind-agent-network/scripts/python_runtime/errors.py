class AgentNetworkHttpError(Exception):
    def __init__(self, status, code=None, message=None, *, response=None, headers=None):
        super().__init__(message or "Agent Network request failed with HTTP %s" % status)
        self.status = status
        self.code = code
        self.response = response
        self.headers = headers or {}
        self.correction = response.get("correction") if isinstance(response, dict) else None
        self.retry_after = self.headers.get("retryAfter")
