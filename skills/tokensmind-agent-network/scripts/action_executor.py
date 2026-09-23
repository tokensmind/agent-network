import uuid

from action_support import ActionState, AuthorizationRequired
from action_validation import text
from python_runtime.errors import AgentNetworkHttpError


def validate_request(value, operations):
    operation = text(value.get("operation")) if isinstance(value, dict) else ""
    data = value.get("input") or {} if isinstance(value, dict) else {}
    if operation not in operations or not isinstance(data, dict):
        raise ActionState(
            "input_required",
            "Provide a supported operation and object input.",
            fields=["operation", "input"],
        )
    return operation, data


def _claim(workflow, operation, data):
    current = workflow.read()
    if not current:
        candidate = {
            "version": 1,
            "id": str(uuid.uuid4()),
            "operation": operation,
            "input": data,
        }
        workflow.write(candidate)
        current = workflow.read()
    if not current:
        raise RuntimeError("Workflow claim returned no state")
    if current.get("operation") != operation or current.get("input") != data:
        raise ActionState(
            "failed",
            "Another %s action is pending." % current.get("operation", "Agent Network"),
            code="AGENT_NETWORK_ACTION_PENDING",
            retryable=False,
        )
    return current


def _abandon(workflow):
    abandoned = workflow.remove()
    return {
        "status": "completed",
        "operation": "abandon_action",
        "data": {"abandoned": abandoned},
    }


def _failure_result(error):
    is_http = isinstance(error, AgentNetworkHttpError)
    retryable = is_http and (error.status == 429 or error.status >= 500)
    result = {
        "status": "failed",
        "code": getattr(error, "code", None) or "AGENT_NETWORK_ACTION_ERROR",
        "message": str(error),
        "retryable": retryable,
    }
    if not is_http or not isinstance(error.status, int):
        return result
    result["httpStatus"] = error.status
    if error.correction:
        result["correction"] = error.correction
    if error.retry_after:
        result["retryAfter"] = error.retry_after
    return result


class ActionExecutor:
    def __init__(self, api, workflow, *, handlers, operations):
        self._api = api
        self._workflow = workflow
        self._handlers = handlers
        self._operations = operations

    def execute(self, value):
        try:
            operation, data = validate_request(value, self._operations)
        except ActionState as error:
            return {"status": error.status, **error.data}
        if operation == "abandon_action":
            return _abandon(self._workflow)
        try:
            current = _claim(self._workflow, operation, data)
        except ActionState as error:
            return {"status": error.status, **error.data}
        except Exception as error:
            return _failure_result(error)
        return self._run(operation, data, current["id"])

    def _run(self, operation, data, key):
        try:
            result = self._handlers[operation](self._api, data, key)
            self._workflow.remove()
            return {"status": "completed", "operation": operation, "data": result}
        except ActionState as error:
            if error.status != "authorization_required":
                self._workflow.remove()
            return {"status": error.status, **error.data}
        except AuthorizationRequired as error:
            return {
                "status": "authorization_required",
                "message": str(error),
                "verificationUrl": error.url,
            }
        except Exception as error:
            result = _failure_result(error)
            if not result["retryable"]:
                self._workflow.remove()
            return result
