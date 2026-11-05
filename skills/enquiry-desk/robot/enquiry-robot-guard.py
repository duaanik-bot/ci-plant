#!/usr/bin/env python3
"""Guard for the unattended enquiry desk robot (scheduled task "enquiry-desk-robot").

Claude Code runs this before every tool call in sessions started in this folder. It does nothing in
ordinary sessions. In a robot session (a run of that scheduled task, see is_robot) it lets
through only what the enquiry-desk skill needs: the desk helper, local work in a temporary folder,
reading Gmail and saving ONE draft. Everything else is refused, above all sending mail: a person
checks every reply and sends it from Gmail.

Set up 2026-11-05 with the 15-minute robot, at Anik's go-ahead. Python 3.9+, standard library only.
"""
import json
import os
import re
import sys

ROBOT_MARKER = 'CI-PLANT-ENQUIRY-ROBOT'
ROBOT_TASK = 'enquiry-desk-robot'
# In ANY session a Bash command carrying this word is refused: a harmless way to prove the guard is live.
PROBE = 'ROBOT-GUARD-PROBE-7d1c'

TOOLS_OK = {'Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill', 'ToolSearch'}
GMAIL_OK = {'search_threads', 'get_thread', 'get_message', 'get_draft', 'list_drafts', 'list_labels', 'create_draft'}
SEND_TOOLS = re.compile(r'__(send_message|reply|forward|send_draft)$')
TMP_ROOTS = ('/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/')
BASH_NO = re.compile(
    r'osascript|sendmail|smtplib|mailx|\bcurl\b|\bwget\b|\bnc\s|\bssh\s|\bscp\s|\bsftp\b|launchctl|crontab'
    r'|\bgit\s+(push|commit)|\bsecurity\s+(find|dump|add|delete)'
    r'|enquiry-desk\.env|\.config/ci-plant|\.claude/settings|\.claude/hooks|scheduled-tasks|enquiry-robot-guard',
    re.I)


def decide(decision, reason):
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': decision, 'permissionDecisionReason': reason}}))
    sys.exit(0)


def first_prompt(path):
    """The session's first prompt: the queued prompt, else the first user message. None if unreadable."""
    try:
        with open(path, encoding='utf-8') as fh:
            for n, line in enumerate(fh):
                if n > 400:
                    break
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get('type') == 'queue-operation' and d.get('operation') == 'enqueue' \
                        and isinstance(d.get('content'), str):
                    return d['content']
                if d.get('type') == 'user' and not d.get('isMeta'):
                    c = (d.get('message') or {}).get('content')
                    if isinstance(c, str):
                        return c
                    if isinstance(c, list):
                        return ' '.join(x.get('text', '') for x in c
                                        if isinstance(x, dict) and x.get('type') == 'text')
    except (OSError, TypeError):
        return None
    return ''


def robot_rules(tool, inp):
    if tool.startswith('mcp__'):
        if tool.startswith('mcp__ccd_turn__'):
            return
        name = tool.rsplit('__', 1)[-1]
        if name in GMAIL_OK:
            return
        decide('deny', f'The enquiry desk robot may only read Gmail and save one draft: {name} is refused. '
                       'It never sends, forwards, deletes or labels mail.')
    if tool not in TOOLS_OK:
        decide('deny', f'The enquiry desk robot does not use {tool}.')
    if tool == 'Skill':
        skill = str(inp.get('skill', ''))
        if skill != 'enquiry-desk' and not skill.endswith(':enquiry-desk'):
            decide('deny', 'The enquiry desk robot uses only the enquiry-desk skill.')
    if tool == 'Bash' and BASH_NO.search(str(inp.get('command', ''))):
        decide('deny', 'The enquiry desk robot runs only the desk helper and local file work; this command is refused.')
    if tool in ('Write', 'Edit'):
        path = os.path.realpath(str(inp.get('file_path', '')))
        if not path.startswith(TMP_ROOTS):
            decide('deny', 'The enquiry desk robot writes only in a temporary folder.')
    if tool in ('Read', 'Grep', 'Glob'):
        target = ' '.join(str(inp.get(k, '')) for k in ('file_path', 'path', 'pattern'))
        if 'enquiry-desk.env' in target or '.config/ci-plant' in target:
            decide('deny', 'The robot key is never read into the conversation.')


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    tool = str(data.get('tool_name') or '')
    inp = data.get('tool_input') or {}
    if not isinstance(inp, dict):
        inp = {}
    if tool == 'Bash' and PROBE in str(inp.get('command', '')):
        decide('deny', 'Robot guard probe: the guard is live.')
    prompt = first_prompt(str(data.get('transcript_path') or ''))
    if prompt is None:
        # Cannot tell whether this is the robot: a send waits for a person instead of going out.
        if SEND_TOOLS.search(tool):
            decide('ask', 'The enquiry robot guard could not read this session; confirm this send yourself.')
        return
    if is_robot(prompt):
        robot_rules(tool, inp)


def is_robot(prompt):
    """The app opens a scheduled run with <scheduled-task name="..."> around the task's prompt; an
    ordinary session never starts that way, so a mention of the marker later on does not count."""
    p = prompt.lstrip()
    if p.startswith(ROBOT_MARKER):
        return True
    if p.startswith('<scheduled-task'):
        return p.startswith(f'<scheduled-task name="{ROBOT_TASK}"') or ROBOT_MARKER in p[:3000]
    return False


if __name__ == '__main__':
    main()
