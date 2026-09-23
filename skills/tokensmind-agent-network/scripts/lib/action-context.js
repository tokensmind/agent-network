function mutationKey(workflow, label) {
  return `${workflow.id}:${label}`;
}

export function createActionContext({ api, workflow }) {
  return {
    input: workflow.input,
    get(path) {
      return api.request({ method: 'GET', path });
    },
    mutate({ method, path, body, label }) {
      return api.request({
        method,
        path,
        body,
        idempotencyKey: mutationKey(workflow, label),
      });
    },
    messageId(label) {
      return mutationKey(workflow, `${label}:message`);
    },
  };
}
