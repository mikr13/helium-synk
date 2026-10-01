import Dexie, { type Table } from 'dexie';
import { encryptDiagnostic, validateRecoveryKey } from './crypto';
import { parseCredentials, type Credentials, type Diagnostic, type Envelope } from './protocol';

export interface LocalState {
  id: 'local';
  credentials: Credentials;
  recovery_key: string;
  next_counter: number;
  cursor: number;
  server_epoch?: string;
  last_synced?: string;
}
export interface LocalRecord {
  operation_id: string;
  envelope: Envelope;
  payload: Diagnostic;
  sequence?: number;
}
export class SynkDatabase extends Dexie {
  state!: Table<LocalState, string>;
  outbox!: Table<Envelope, string>;
  records!: Table<LocalRecord, string>;

  constructor(name = 'helium-synk-v1') {
    super(name);
    this.version(1).stores({
      state: 'id',
      outbox: 'operation_id, counter',
      records: 'operation_id, sequence, envelope.device_id',
    });
  }

  async enroll(credentials: Credentials, recoveryKey: string): Promise<void> {
    const parsed = parseCredentials(credentials);
    validateRecoveryKey(recoveryKey);
    await this.transaction('rw', this.state, async () => {
      if (await this.state.get('local')) throw new Error('This profile is already enrolled.');
      await this.state.add({
        id: 'local',
        credentials: parsed,
        recovery_key: recoveryKey,
        next_counter: 1,
        cursor: 0,
      });
    });
  }

  async queueDiagnostic(note: string): Promise<string> {
    if (!note.trim() || note.length > 2_000)
      throw new Error('Enter a test note of up to 2,000 characters.');
    // Reserve a counter durably before asynchronous crypto. Gaps are allowed; reuse is not.
    const state = await this.transaction('rw', this.state, async () => {
      const current = await this.state.get('local');
      if (!current) throw new Error('Connect this device first.');
      if (current.next_counter >= Number.MAX_SAFE_INTEGER)
        throw new Error('Device counter exhausted.');
      await this.state.update('local', { next_counter: current.next_counter + 1 });
      return current;
    });
    const payload: Diagnostic = {
      kind: 'diagnostic',
      note: note.trim(),
      created_at: new Date().toISOString(),
    };
    const envelope = await encryptDiagnostic(
      state.recovery_key,
      {
        protocol_version: 1,
        operation_id: crypto.randomUUID(),
        account_id: state.credentials.account_id,
        device_id: state.credentials.device_id,
        counter: state.next_counter,
        domain: 'diagnostic',
        key_epoch: 1,
      },
      payload,
    );
    await this.transaction('rw', this.records, this.outbox, async () => {
      await this.records.add({ operation_id: envelope.operation_id, envelope, payload });
      await this.outbox.add(envelope);
    });
    return envelope.operation_id;
  }
}
