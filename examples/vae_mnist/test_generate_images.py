from generate_images import _batch_rows, _flatten_public_values


def test_public_outputs_accept_nested_lists():
    assert _flatten_public_values([[1, 2], [3, 4]]) == [1, 2, 3, 4]
    assert _batch_rows([[[1, 2]], [[3, 4]]], 2) == [[1, 2], [3, 4]]


def test_public_outputs_accept_tensor_like_values():
    class TensorLike:
        def __init__(self, value):
            self.value = value

        def detach(self):
            return self

        def cpu(self):
            return self

        def reshape(self, *shape):
            return self

        def tolist(self):
            return self.value

    assert _batch_rows(TensorLike([[1, 2], [3, 4]]), 2) == [[1, 2], [3, 4]]
