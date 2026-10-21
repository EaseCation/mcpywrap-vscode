(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let state = { sessions: [], transcript: [], busy: false };
  const previous = vscode.getState() || {};
  $('code').value = previous.code || '';
  const send = (type, fields = {}) => vscode.postMessage({ type, ...fields });
  function render() {
    const selected = state.sessions.find(item => item.key === state.selected);
    const oldSide = $('side').value;
    $('session').replaceChildren(...state.sessions.map(item => {
      const option = document.createElement('option'); option.value = item.key; option.textContent = item.label; return option;
    }));
    $('session').value = state.selected || '';
    $('side').replaceChildren(...(selected?.sides || []).map(side => {
      const option = document.createElement('option'); option.value = side; option.textContent = side === 'client' ? '客户端 · client' : '服务端 · server'; return option;
    }));
    if (selected?.sides.includes(oldSide)) $('side').value = oldSide;
    $('status').textContent = state.status || '';
    $('run').disabled = state.busy || !selected?.sides.length || !$('code').value.trim();
    $('run').textContent = state.busy ? '正在执行…' : '运行片段';
    const nearBottom = $('transcript').scrollHeight - $('transcript').scrollTop - $('transcript').clientHeight < 80;
    const source = $('filter').value;
    $('transcript').replaceChildren(...state.transcript.filter(item => source === 'all' || item.source === source).map(item => {
      const entry = document.createElement('article');
      const label = document.createElement('small'); label.textContent = item.label;
      const output = document.createElement('pre'); output.textContent = item.text;
      entry.append(label, output); return entry;
    }));
    if (nearBottom) $('transcript').scrollTop = $('transcript').scrollHeight;
  }
  function execute() {
    if ($('run').disabled) return;
    send('execute', { key: $('session').value, side: $('side').value, code: $('code').value });
  }
  $('run').addEventListener('click', execute);
  $('session').addEventListener('change', () => send('select', { key: $('session').value }));
  $('refresh').addEventListener('click', () => send('refresh'));
  $('reconnect').addEventListener('click', () => send('reconnect'));
  $('disconnect').addEventListener('click', () => send('disconnect'));
  $('clear').addEventListener('click', () => send('clear'));
  $('filter').addEventListener('change', render);
  $('code').addEventListener('input', () => { vscode.setState({ code: $('code').value }); $('run').disabled = state.busy || !$('side').value || !$('code').value.trim(); });
  $('code').addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); execute(); }
  });
  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    const data = event.data;
    const transcript = [...new Map([...state.transcript, ...(data.entries || [])].map(item => [item.id, item])).values()]
      .filter(item => item.id >= data.firstId);
    state = { ...data, transcript }; render();
  });
  send('ready');
})();
