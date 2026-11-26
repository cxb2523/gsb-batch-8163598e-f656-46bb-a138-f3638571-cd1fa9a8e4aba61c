import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import SSTVDecoder from '../SSTVDecoder';

/**
 * Component-level coverage for the three requested scenarios:
 *  - switching mode updates stats + dimensions and keeps recording alive
 *  - Stop cancels queued animation-frame callbacks
 *  - starting again shows progress from zero
 *
 * AudioContext / getUserMedia / canvas are provided by jest.setup.js.
 */
describe('SSTVDecoder session UI', () => {
  it('switching mode while recording updates mode stats/dimensions without stopping', async () => {
    const onModeChange = jest.fn();
    const { container } = render(
      <SSTVDecoder selectedMode="ROBOT36" onModeChange={onModeChange} />,
    );

    const startButton = await screen.findByRole('button', { name: /start decoding/i });
    expect(startButton).toBeEnabled();

    fireEvent.click(startButton);
    const stopButton = await screen.findByRole('button', { name: /^stop$/i });
    expect(stopButton).toBeInTheDocument();

    // Settings entry must remain enabled during recording.
    const settingsButton = screen.getByRole('button', { name: /settings/i });
    expect(settingsButton).not.toBeDisabled();

    fireEvent.click(settingsButton);
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: /PD 120/ }));

    // Controlled parent callback fired with the new mode.
    expect(onModeChange).toHaveBeenCalledWith('PD120');

    // Recording was NOT interrupted: Stop is still on screen.
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();

    // Header dimensions switched to PD120.
    await waitFor(() => {
      expect(screen.getByText(/640\s*×\s*496/)).toBeInTheDocument();
    });

    // Main decoded canvas resized to the new dimensions.
    const decodedCanvas = container.querySelector('canvas') as HTMLCanvasElement;
    await waitFor(() => {
      expect(decodedCanvas.width).toBe(640);
      expect(decodedCanvas.height).toBe(496);
    });

    // Stats show the new mode name and total line count, progress at zero.
    await waitFor(() => {
      expect(screen.getAllByText('PD 120').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/0\s*\/\s*496/)).toBeInTheDocument();
  });

  it('stopping cancels queued requestAnimationFrame callbacks', async () => {
    const cancelSpy = jest.spyOn(globalThis, 'cancelAnimationFrame');
    render(<SSTVDecoder selectedMode="ROBOT36" onModeChange={jest.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /start decoding/i }));
    const stopButton = await screen.findByRole('button', { name: /^stop$/i });

    cancelSpy.mockClear();
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start decoding/i })).toBeInTheDocument();
    });

    // Both the hook poll cleanup (if any) and the canvas loop cleanup cancel.
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it('stopping then starting again shows progress from zero', async () => {
    render(<SSTVDecoder selectedMode="ROBOT36" onModeChange={jest.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /start decoding/i }));
    await screen.findByRole('button', { name: /^stop$/i });
    expect(screen.getByText(/0\s*\/\s*240/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    const startButton = await screen.findByRole('button', { name: /start decoding/i });

    fireEvent.click(startButton);
    await screen.findByRole('button', { name: /^stop$/i });

    // Fresh session: line counter is back at 0 / 240.
    await waitFor(() => {
      expect(screen.getByText(/0\s*\/\s*240/)).toBeInTheDocument();
    });
  });
});
