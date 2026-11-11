#!/usr/bin/env python3
"""CI Plant enquiry desk helper: the robot's calls to CI Plant, with the AVS robot key.

    python3 desk.py jobs | claim N | file N mails.json | counters N counters.json | attachment N out.pdf | sent-drafts N '<json>'
                    | done N '<json>' | fail N "why"

Settings, from the environment or ~/.config/ci-plant/enquiry-desk.env (KEY=VALUE lines):
    CI_PLANT_URL   default https://motionci.in
    CI_ROBOT_KEY   the AVS robot key (AVS_ROBOT_KEY is read too)
Standard library only. Never prints the key.
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

CONF = os.path.expanduser('~/.config/ci-plant/enquiry-desk.env')


def settings():
    vals = {}
    if os.path.exists(CONF):
        for line in open(CONF, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                vals[k.strip().removeprefix('export ').strip()] = v.strip().strip('"').strip("'")
    url = os.environ.get('CI_PLANT_URL') or vals.get('CI_PLANT_URL') or 'https://motionci.in'
    key = (os.environ.get('CI_ROBOT_KEY') or os.environ.get('AVS_ROBOT_KEY')
           or vals.get('CI_ROBOT_KEY') or vals.get('AVS_ROBOT_KEY'))
    if not key:
        sys.exit('No robot key: set CI_ROBOT_KEY (the AVS robot key) or put it in ' + CONF)
    return url.rstrip('/'), key


def call(method, path, body=None, raw=False):
    url, key = settings()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + '/api/avs/robot' + path, data=data, method=method, headers={
        'x-avs-robot-key': key, 'x-avs-runner': os.environ.get('CI_RUNNER_NAME', 'Claude (enquiry desk)'),
        'Content-Type': 'application/json', 'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            payload = res.read()
            return (payload, dict(res.headers)) if raw else json.loads(payload or b'{}')
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8', 'replace')
        try:
            text = json.loads(text).get('error', text)
        except ValueError:
            pass
        sys.exit(f'CI Plant answered {e.code}: {text}')
    except urllib.error.URLError as e:
        sys.exit(f'CI Plant could not be reached: {e.reason}')


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == 'jobs':
        jobs = call('GET', '/enquiry-jobs')
        if args:
            jobs = [j for j in jobs if j.get('mailbox_email', '').lower() == args[0].lower()]
        return out(jobs)
    if cmd == 'claim' and len(args) == 1:
        return out(call('POST', f'/enquiry-jobs/{int(args[0])}/claim', {}))
    if cmd == 'file' and len(args) == 2:
        mails = json.load(open(args[1], encoding='utf-8'))
        if isinstance(mails, dict):
            mails = mails.get('mails', [])
        total = {'filed': [], 'skipped': [], 'refused': []}
        for i in range(0, len(mails), 25):
            res = call('POST', f'/enquiry-jobs/{int(args[0])}/mails', {'mails': mails[i:i + 25]})
            for k in total:
                total[k] += res.get(k, [])
        return out(total)
    if cmd == 'attachment' and len(args) == 2:
        data, headers = call('GET', f'/enquiry-jobs/{int(args[0])}/attachment', raw=True)
        want = {k.lower(): v for k, v in headers.items()}.get('x-attachment-sha256', '')
        got = hashlib.sha256(data).hexdigest()
        if want and want != got:
            sys.exit(f'The PDF does not match the one CI Plant queued (sha256 {got} vs {want}) — do not send it.')
        with open(args[1], 'wb') as f:
            f.write(data)
        return out({'saved': args[1], 'bytes': len(data), 'sha256': got})
    if cmd == 'counters' and len(args) == 2:
        body = json.load(open(args[1], encoding='utf-8'))
        return out(call('POST', f'/enquiry-jobs/{int(args[0])}/counters', body))
    if cmd == 'sent-drafts' and len(args) == 2:
        return out(call('POST', f'/enquiry-jobs/{int(args[0])}/sent-drafts', {'sent': json.loads(args[1])}))
    if cmd == 'done' and len(args) in (1, 2):
        result = json.loads(args[1]) if len(args) == 2 else {}
        return out(call('POST', f'/enquiry-jobs/{int(args[0])}/done', {'ok': True, 'result': result}))
    if cmd == 'fail' and len(args) == 2:
        return out(call('POST', f'/enquiry-jobs/{int(args[0])}/done', {'ok': False, 'error': args[1]}))
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
