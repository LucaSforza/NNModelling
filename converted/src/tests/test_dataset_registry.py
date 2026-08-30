from backend.dataset_registry import discover_datasets


def test_mnist_dataset_catalog_preserves_constructor_types():
    datasets = {dataset.target: dataset for dataset in discover_datasets()}

    autoencoder = datasets["dataset.autoencoder_mnist.AutoencoderMNIST"]

    assert [(parameter.name, parameter.type, parameter.default) for parameter in autoencoder.parameters] == [
        ("batch_size", "int", 32),
        ("num_workers", "int", 0),
        ("train_size", "float", 0.8),
    ]
