// Simple prefix-based title map for the topbar. Screens are free to render
// their own <h1>/PageHeader inside the content area for anything more
// specific (e.g. an invoice number) - this only drives the shared chrome.
export function pageTitleFor(pathname: string): string {
  if (pathname.startsWith('/dashboard')) return 'Dashboard';
  if (pathname.startsWith('/invoices')) return 'Invoices';
  if (pathname.startsWith('/customers')) return 'Customers';
  if (pathname.startsWith('/integrations')) return 'Integrations';
  return 'Clearbook';
}
