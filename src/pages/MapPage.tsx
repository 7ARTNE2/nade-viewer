import MapWorkspace from './MapWorkspace';

export default function MapPage({
  activeImportId,
  tutorialStep,
}: {
  activeImportId: number;
  tutorialStep?: number | null;
}) {
  return (
    <MapWorkspace
      source={{ kind: 'import', activeImportId }}
      tutorialStep={tutorialStep}
    />
  );
}
