type SkeletonRowsProps = {
  count?: number;
  compact?: boolean;
};

export const SkeletonRows = ({ count = 5, compact = false }: SkeletonRowsProps) => (
  <div class={`skeleton-rows${compact ? " compact" : ""}`} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => (
      <div class="skeleton-row" key={index}>
        <i />
        <span />
        <b />
      </div>
    ))}
  </div>
);

export const BootScreen = ({ leaving }: { leaving: boolean }) => (
  <main class={`boot-screen${leaving ? " leaving" : ""}`} aria-label="正在载入">
    <div class="boot-skeleton" aria-hidden="true">
      <header><i /><span /><b /></header>
      <section class="boot-skeleton-grid">
        <div class="boot-skeleton-primary"><i /><strong /><span /><span /><b /></div>
        <div><i /><strong /><SkeletonRows count={4} compact /></div>
        <div><i /><strong /><SkeletonRows count={5} compact /></div>
      </section>
    </div>
  </main>
);
