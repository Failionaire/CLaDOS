interface ConfirmModalProps {
  title: string;
  message: string;
  quip?: string;
  variant?: 'danger' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, quip, variant = 'danger', onConfirm, onCancel }: ConfirmModalProps) {
  const isDanger = variant === 'danger';

  return (
    <>
      <div className="confirm-overlay" onClick={onCancel} />
      <div className="confirm-panel">
        <div className={`hazard-bar ${isDanger ? 'red' : 'amber'}`} />
        <div className="confirm-header">{title}</div>
        <div className="confirm-body">
          <p className="confirm-message">{message}</p>
          {quip && <p className="confirm-quip">{quip}</p>}
        </div>
        <div className="confirm-actions">
          <button className={isDanger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            Confirm
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
