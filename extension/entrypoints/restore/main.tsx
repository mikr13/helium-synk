import { createRoot } from 'react-dom/client';
import { ArrowUpRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import '@/styles/theme.css';

function RestorePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12">
      <Card className="w-full border-t-2 border-t-brand-blue">
        <CardHeader className="border-b py-6">
          <div className="mb-6 flex items-center gap-3">
            <img src="/icons/128.png" width="40" height="40" alt="" />
            <span className="font-mono text-xs tracking-widest text-primary">HELIUM SYNK</span>
          </div>
          <CardTitle className="text-3xl font-extrabold tracking-tight">
            <h1>Your session is opening.</h1>
          </CardTitle>
          <CardDescription className="mt-3 leading-7">
            This temporary tab helps recover progress if restoration is interrupted. It closes once
            this window is ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-6">
          <p className="mb-6 text-sm leading-7 text-muted-foreground">
            If it remains, open Helium Synk to review progress. Cancelling keeps the tabs already
            opened.
          </p>
          <Button asChild>
            <a href="/options.html">
              Open Helium Synk <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<RestorePage />);
