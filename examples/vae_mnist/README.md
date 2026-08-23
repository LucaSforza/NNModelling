# VAE MNIST: pacchetto trainato

`vae_mnist_trained-package.zip` è stato scaricato dal backend dopo un training
containerizzato del diagramma `variational-autoencoder-complete.json`. Contiene
il package graph originale, i pesi `safetensors` e il riepilogo del training.

Per rigenerare le immagini dal pacchetto:

```bash
PYTHONPATH=converted/src uv run python examples/vae_mnist/generate_images.py
```

Lo script usa il test set MNIST già presente in `converted/data`, salva una
griglia di ricostruzioni in `generated/reconstructions.png` e genera una seconda
griglia da latenti casuali in `generated/generated.png`.
