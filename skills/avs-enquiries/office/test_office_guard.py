"""Tests for the office AVS enquiry run's guard (client/public/office/avs-enquiry-watch/avs-office-guard.py).

    python3 -m unittest skills/avs-enquiries/office/test_office_guard.py
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

GUARD = pathlib.Path(__file__).resolve().parents[3] / 'client/public/office/avs-enquiry-watch/avs-office-guard.py'
spec = importlib.util.spec_from_file_location('guard', GUARD)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def run(tool, inp):
    out = subprocess.run([sys.executable, str(GUARD)], input=json.dumps({'tool_name': tool, 'tool_input': inp}),
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)['hookSpecificOutput']['permissionDecision'] if out.strip() else None


SQL = 'mcp__claude_ai_Supabase__execute_sql'


class Tools(unittest.TestCase):
    def test_reading_the_mailbox_is_allowed(self):
        for t in ('search_threads', 'get_thread', 'get_message', 'list_labels', 'download_gmail_attachment'):
            self.assertEqual(run(f'mcp__claude_ai_Gmail__{t}', {}), 'allow', t)

    def test_nothing_is_ever_sent_drafted_or_changed_in_the_mailbox(self):
        for t in ('send_message', 'reply', 'forward', 'create_draft', 'update_draft', 'trash_thread', 'label_message',
                  'update_message_labels', 'delete_draft'):
            self.assertEqual(run(f'mcp__claude_ai_Gmail__{t}', {}), 'deny', t)

    def test_its_own_reading_tools_are_allowed_and_the_shell_and_writing_files_are_not(self):
        for t in ('Skill', 'Read', 'Glob', 'Grep', 'ToolSearch'):
            self.assertEqual(run(t, {}), 'allow', t)
        for t in ('Bash', 'Write', 'Edit', 'WebFetch', 'mcp__claude_ai_Supabase__apply_migration', 'mcp__x__deploy_edge_function'):
            self.assertEqual(run(t, {'command': 'ls'}), 'deny', t)


class Sql(unittest.TestCase):
    def ok(self, q):
        return run(SQL, {'query': q, 'project_id': 'p'})

    def test_reading_and_the_three_avs_calls_are_allowed(self):
        for q in ('select avs.take_enquiry_fetch();',
                  "SELECT avs.finish_enquiry_fetch(12, '{\"read\": 4, \"filed\": 1}'::jsonb)",
                  'select gmail_message_id from avs.enquiry_intake where created_at > now() - interval \'30 days\'',
                  "with q as (select 1) select * from q",
                  'select name from customers where active = 1'):
            self.assertEqual(self.ok(q), 'allow', q)

    def test_a_mail_full_of_words_like_update_and_delete_is_still_filed(self):
        q = ("select avs.file_enquiry_mails($m$[{\"body_text\": \"Please update the rate; delete the old one. "
             "DROP me a line; insert the new size\", \"gmail_message_id\": \"a1\"}]$m$::jsonb);")
        self.assertEqual(self.ok(q), 'allow')
        self.assertEqual(self.ok("select avs.file_enquiry_mails('[{\"summary\": \"it''s an update\"}]'::jsonb)"), 'allow')

    def test_any_write_or_second_statement_is_refused(self):
        for q in ('update enquiries set status = \'new\'', 'delete from avs.enquiry_intake',
                  'select 1; delete from enquiries', 'insert into enquiries default values',
                  'drop table x', 'alter table x add y int', 'truncate enquiries', 'grant all on x to anon',
                  'create table x (a int)', "select set_config('role', 'x', false)", 'select pg_terminate_backend(1)',
                  'select avs.something_else()', "select net.http_post('https://x')", 'select dblink(\'x\', \'y\')',
                  'copy enquiries to stdout', 'do $$ begin delete from x; end $$', '-- comment only'):
            self.assertEqual(self.ok(q), 'deny', q)

    def test_hidden_statement_after_a_quoted_string_is_refused(self):
        self.assertEqual(self.ok("select 'a'; delete from enquiries"), 'deny')
        self.assertEqual(self.ok("select $x$ ; $x$; update enquiries set notes = 'x'"), 'deny')


if __name__ == '__main__':
    unittest.main()
