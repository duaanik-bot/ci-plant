#!/usr/bin/env python3
"""Guard for the office computer's AVS enquiry runs (owner, 14 Nov 2026).

The watcher (watch.sh) starts Claude in its own folder when someone presses "Fetch from mail" on CI Plant's Enquiry
desk. Nobody is watching that run, so Claude Code calls this before every tool, in every session started in that
folder, and lets through only what the avs-enquiries skill needs:

  * reading the company mailbox (search, open, attachments) - never sending, replying, forwarding, drafting,
    labelling or deleting anything;
  * one SQL statement at a time that only reads, or calls the three avs functions of the skill
    (take_enquiry_fetch, file_enquiry_mails, finish_enquiry_fetch);
  * reading files and loading its skill.

Everything else - the shell, writing files, any other connector tool - is refused.
Python 3.9+, standard library only. Tests: skills/avs-enquiries/office/test_office_guard.py
"""
import json
import re
import sys

TOOLS_OK = {'Skill', 'Read', 'Glob', 'Grep', 'ToolSearch'}
GMAIL_READ = {'search_threads', 'get_thread', 'get_message', 'list_labels', 'download_gmail_attachment'}
AVS_FUNCTIONS = {'take_enquiry_fetch', 'file_enquiry_mails', 'finish_enquiry_fetch'}
WRITE_WORDS = re.compile(
    r'\b(insert|update|delete|merge|upsert|alter|drop|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|reindex'
    r'|cluster|comment|refresh|lock|listen|notify|unlisten|prepare|execute|deallocate|reset|set|security|owner'
    r'|import|load|discard|checkpoint|savepoint|rollback|commit|begin|start)\b', re.I)
BAD_FUNCTIONS = re.compile(
    r'\b(set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_read_file|pg_read_binary_file|pg_ls_dir'
    r'|pg_stat_file|lo_import|lo_export|lo_unlink|dblink\w*|http\w*|pg_sleep\w*|txid_\w+|pg_advisory\w*|query_to_xml'
    r'|query_to_json|current_setting)\s*\(', re.I)


def decide(decision, reason):
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': decision, 'permissionDecisionReason': reason}}))
    sys.exit(0)


def without_text(sql):
    """The SQL with its quoted text and comments taken out, so a mail's own words are never read as SQL."""
    s = re.sub(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$.*?\$\1\$', ' ', sql, flags=re.S)
    s = re.sub(r"'(?:[^']|'')*'", ' ', s)
    s = re.sub(r'"(?:[^"]|"")*"', ' ', s)
    s = re.sub(r'--[^\n]*', ' ', s)
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    return s


def sql_problem(sql):
    if not isinstance(sql, str) or not sql.strip():
        return 'no SQL'
    s = without_text(sql).strip()
    s = re.sub(r';\s*$', '', s).strip()
    if not s:
        return 'no SQL'
    if ';' in s:
        return 'one statement at a time'
    if not re.match(r'(select|with)\b', s, re.I):
        return 'only SELECT statements'
    word = WRITE_WORDS.search(s)
    if word:
        return f'"{word.group(1)}" is not for this run'
    if BAD_FUNCTIONS.search(s):
        return 'that function is not for this run'
    for schema, fn in re.findall(r'\b([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w]*)\s*\(', s):
        if schema.lower() == 'avs' and fn.lower() not in AVS_FUNCTIONS:
            return f'avs.{fn} is not one of the skill\'s calls'
        if schema.lower() in ('net', 'extensions', 'pg_catalog', 'dblink', 'vault', 'storage', 'auth', 'cron', 'supabase_functions'):
            return f'{schema}.{fn} is not for this run'
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        decide('deny', 'The guard could not read the tool call.')
    tool = str(data.get('tool_name') or '')
    inp = data.get('tool_input') or {}
    if tool in TOOLS_OK:
        decide('allow', 'Reading only.')
    m = re.match(r'mcp__.+__([A-Za-z0-9_]+)$', tool)
    if m:
        name = m.group(1)
        if name in GMAIL_READ:
            decide('allow', 'Reading the company mailbox.')
        if name == 'execute_sql':
            problem = sql_problem(inp.get('query'))
            if problem:
                decide('deny', f'Office AVS run: {problem}. It may only read, and file through the avs functions.')
            decide('allow', 'A read, or one of the skill\'s avs calls.')
    decide('deny', f'Office AVS run: {tool} is not used by the avs-enquiries skill (mail is read only, nothing else changes).')


if __name__ == '__main__':
    main()
