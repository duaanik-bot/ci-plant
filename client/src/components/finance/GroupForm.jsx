// GroupForm: adding a group, or renaming and moving one (spec §6.3). An admin's form: the chart only offers it to one (finGroupActions).
//
//   <GroupForm book={book} groups={groups} onClose={...} onSaved={...} onFailed={...} />                 add: pick the group it sits under, name it
//   <GroupForm ... group={group} />                                                                     edit: rename it, or move it
//   <GroupForm ... parentId={7} />                                                                      add, under group 7 to begin with
//
// POST /finance/groups { book_id, parent_id, name } · PUT /finance/groups/:id { name, parent_id }. A new group takes the nature (and the
// side of gross profit) of the group it sits under, so it is always filed under one. An edit offers only the groups the server would let
// it move under (finGroupMoveTargets: the same nature and side, never itself or anything below it). Ruling R19: a built-in group is never
// renamed or moved, so the chart never opens this form on one (finGroupActions says no, from the group's `is_system`).
//
// The save button hands back the promise of the write, so the shared Button holds it to one press; a refusal leaves the form open with
// what was typed (useFormWrite), and `onFailed` reloads the chart, since another login may have changed it.
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Button, Field, Input, Modal, Select, useToast } from '../ui.jsx';
import { FieldError } from './SetupParts.jsx';
import useFormWrite from './useFormWrite.js';
import { finGroupChoices, finGroupMoveTargets } from '../../lib/finance/setup.js';

// The groups as a picker's options, each indented by its depth in the tree.
export const groupOptions = choices => choices.map(c => ({ value: c.id, label: c.name, depth: c.depth, search: c.name }));
export const renderGroupOption = item => (
  <span className="block truncate" style={{ paddingLeft: `${(item.depth ?? 0) * 0.9}rem` }}>{item.label}</span>
);

export default function GroupForm({ book, groups, group = null, parentId = null, onClose, onSaved, onFailed }) {
  const toast = useToast();
  const { problems, attempt } = useFormWrite();
  const [name, setName] = useState(group?.name ?? '');
  const [parent, setParent] = useState(group ? group.parent_id : parentId);

  const options = useMemo(() => groupOptions(group ? finGroupMoveTargets(groups, group) : finGroupChoices(groups)), [groups, group]);
  const changed = !group || name.trim() !== group.name || Number(parent) !== group.parent_id;
  const ready = name.trim() !== '' && parent != null && parent !== '' && changed;

  const save = async () => {
    const body = { name: name.trim(), parent_id: Number(parent) };
    const done = await attempt(
      () => (group ? api.put(`/finance/groups/${group.id}`, body) : api.post('/finance/groups', { book_id: book.id, ...body })),
      { onFail: onFailed });
    if (!done) return;
    toast.success(group ? 'Group saved' : 'Group added');
    await onSaved();
  };

  return (
    <Modal open onClose={onClose} title={group ? `Edit ${group.name}` : 'Add a group'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ready}>{group ? 'Save' : 'Add group'}</Button>
      </>}>
      <div className="space-y-3">
        <Field label="Name" required>
          <Input autoFocus value={name} maxLength={255} onChange={e => setName(e.target.value)} />
          <FieldError>{problems.name}</FieldError>
        </Field>
        <Field label="Sits under" required
          hint={group ? 'A group can move only within its own kind of account, and not under itself.' : 'The new group takes the kind of account of the group it sits under.'}>
          <Select options={options} value={parent ?? ''} placeholder="Choose the group it sits under…" renderOption={renderGroupOption}
            onChange={e => setParent(e.target.value === '' ? null : Number(e.target.value))} />
          <FieldError>{problems.parent_id}</FieldError>
        </Field>
        <FieldError>{problems.form}</FieldError>
      </div>
    </Modal>
  );
}
