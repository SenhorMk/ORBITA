// Derived from CE v4.19.1 profile, inbox and conversation serializers.
// This emulates only the assignment effect of toggle_status for the test.
export function chatwootFixture() {
  const state = { status: 'open', assignee: null, role: 'administrator', automatic: false, failReceipt: false,
    badAccount: false, writes: [], reads: 0 };
  const fetchImpl = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? 'GET';
    if (path === '/api/v1/profile' && method === 'GET') return Response.json({
      id: 17, role: 'administrator', accounts: [{ id: 99, role: 'administrator' }, { id: 1, role: state.role }],
    });
    if (path === '/api/v1/accounts/1/inboxes/1' && method === 'GET') {
      return Response.json({ id: 1, enable_auto_assignment: state.automatic });
    }
    if (path === '/api/v1/accounts/1/conversations/221' && method === 'GET') {
      state.reads++;
      return Response.json({ id: 221, account_id: state.badAccount ? 2 : 1, inbox_id: 1, status: state.status,
        meta: state.assignee === null ? {} : { assignee_type: 'User', assignee: { id: state.assignee } } });
    }
    if (path === '/api/v1/accounts/1/conversations/221/toggle_status' && method === 'POST') {
      const { status } = JSON.parse(init.body);
      state.writes.push(['221', status]);
      state.status = status;
      if (status === 'open' && state.role === 'agent') state.assignee = 17;
      if (state.failReceipt) throw new DOMException('synthetic timeout', 'TimeoutError');
      return Response.json({ payload: { current_status: status } });
    }
    throw Error('Unexpected fixture request: ' + method + ' ' + path);
  };
  return { state, fetchImpl };
}
