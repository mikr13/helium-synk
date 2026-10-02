import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export function Disclosure({
  title,
  defaultOpen = false,
  className,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={className}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          className="w-full justify-between border-y px-0 py-4 text-left"
        >
          <span>{title}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
