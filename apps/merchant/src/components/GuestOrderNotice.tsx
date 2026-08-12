interface GuestOrderContact {
  phone: string
  email: string
}

function normalizePhoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+*#,;]/g, "")}`
}

export function GuestOrderNotice({ contact }: { contact?: GuestOrderContact }) {
  return (
    <aside
      aria-labelledby="guest-order-notice-heading"
      className="mt-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm leading-6 text-warning"
    >
      <h4 id="guest-order-notice-heading" className="font-semibold">
        Conduit can’t message this guest
      </h4>
      {contact ? (
        <>
          <p className="mt-1">
            Contact them directly about payment, shipping, or order changes.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            <a
              href={normalizePhoneHref(contact.phone)}
              className="inline-flex min-h-11 items-center rounded-md underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
            >
              Call {contact.phone}
            </a>
            <a
              href={`mailto:${contact.email}`}
              className="inline-flex min-h-11 items-center rounded-md underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
            >
              Email {contact.email}
            </a>
          </div>
          <p className="mt-2 text-xs leading-5">
            Actions here update your private order history; they do not notify
            the guest.
          </p>
        </>
      ) : (
        <p className="mt-1">
          This order has no contact details. Actions here update only your
          private order history.
        </p>
      )}
    </aside>
  )
}
