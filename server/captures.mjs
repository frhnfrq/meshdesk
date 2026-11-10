import path from 'node:path';

export function captureHandler(dataRoot) {
  const root = path.resolve(dataRoot, 'captures');
  return (req, res) => {
    const name = req.params.name;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(jpg|png)$/.test(name)) {
      return res.sendStatus(404);
    }
    // Resolve only the validated filename beneath this root. Passing the full
    // absolute path makes Express treat the .data parent as a blocked dotfile.
    res.sendFile(name, {root});
  };
}
