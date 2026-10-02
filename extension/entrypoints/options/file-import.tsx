import React, { useEffect, useRef, useState } from 'react';
import { Disclosure } from '@/components/disclosure';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldError, FieldGroup } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/** Secrets stay in component memory and never enter the route or browser storage. */
export function JsonFile({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState('');
  const reading = useRef(0);
  useEffect(
    () => () => {
      reading.current += 1;
    },
    [],
  );
  return (
    <FieldGroup className="connection-file gap-3">
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            const current = ++reading.current;
            setError('');
            onChange('');
            if (!file) return;
            if (file.size > 1_048_576) {
              setError('Choose a connection or recovery file smaller than 1 MB.');
              return;
            }
            try {
              const text = await file.text();
              JSON.parse(text);
              if (current === reading.current) onChange(text);
            } catch {
              if (current === reading.current)
                setError(
                  'This file could not be read as JSON. Choose the file saved by Helium Synk.',
                );
            }
          }}
        />
        {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      </Field>
      <Disclosure title="Paste file contents instead">
        <Field>
          <FieldLabel htmlFor={`${id}-text`}>{label} contents</FieldLabel>
          <Textarea
            id={`${id}-text`}
            value={value}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              reading.current += 1;
              setError('');
              onChange(event.target.value);
            }}
          />
        </Field>
      </Disclosure>
    </FieldGroup>
  );
}
