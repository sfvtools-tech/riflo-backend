export const assetPath = (uid: string, projectId: string, outputId: string, attempt: number, slide: number) => `accounts/${uid}/projects/${projectId}/outputs/${outputId}/attempt-${attempt}/slide-${slide}.png`;
export const videoPath = (uid: string, projectId: string, outputId: string, attempt: number) => `accounts/${uid}/projects/${projectId}/outputs/${outputId}/attempt-${attempt}/clip.mp4`;
