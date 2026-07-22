"""Focused backend coverage for the optional Observable runtime."""

from pathlib import Path
from unittest.mock import Mock

import pytest
import torch
import lightning as lit
from torch.utils.data import DataLoader, TensorDataset
from hydra import compose, initialize_config_dir
from omegaconf import OmegaConf

from convert import build_hydra_configs
from interpretability.manager import ObservableManager
from interpretability.publishers import ResultPublisher
from net.base import Net
from ops.horizontal_repeat import HorizontalRepeat
from ops.repeat import Repeat
from infer import iter_predict_batches

FIXTURE = Path(__file__).parent / "fixtures" / "observable_nntree.json"


def _model_config(tmp_path):
    build_hydra_configs(str(FIXTURE), output_dir=str(tmp_path))
    with initialize_config_dir(config_dir=str(tmp_path), version_base=None):
        cfg = compose(config_name="base")
    OmegaConf.set_struct(cfg, False)
    cfg.trainer.default_root_dir = str(tmp_path)
    return cfg


def test_conversion_emits_separate_interpretability_group(tmp_path):
    build_hydra_configs(str(FIXTURE), output_dir=str(tmp_path))
    net_cfg = OmegaConf.load(tmp_path / "net" / "custom_sequence.yaml")
    obs_cfg = OmegaConf.load(tmp_path / "interpretability" / "observables.yaml")
    assert not any("obs-" in node_id for node_id in net_cfg.nodes)
    assert obs_cfg.enabled is True
    assert obs_cfg.observables["obs-rec"].max_samples == 2
    base = OmegaConf.load(tmp_path / "base.yaml")
    assert {"interpretability": "observables"} in base.defaults


def test_converted_statistics_rows_retain_ordered_source_metadata(tmp_path):
    """Finalized local rows identify the configured source, not capture order."""
    cfg = _model_config(tmp_path)
    model = Net(cfg)
    model.eval()
    model.interpretability.set_context("EVAL", epoch=3, global_step=7, batch_index=2)
    model(torch.ones(2, 3))

    results = model.interpretability.finalize("POST_EPOCH")
    stats = next(result for result in results if result["observable_id"] == "obs-stats")
    assert stats["sources"] == [{
        "sourceNodeId": "linear-visual",
        "sourcePoint": "out",
        "targetHandle": "in-0",
    }]
    assert model.interpretability.publisher.tables["obs-stats"][0]["sources"] == stats["sources"]


def test_runtime_binds_compacted_module_id_and_preserves_output_and_state(tmp_path):
    cfg = _model_config(tmp_path)
    torch.manual_seed(4)
    enabled = Net(cfg)
    state_before = set(enabled.state_dict())
    disabled_cfg = OmegaConf.create(OmegaConf.to_container(cfg, resolve=True))
    disabled_cfg.interpretability.enabled = False
    disabled = Net(disabled_cfg)
    disabled.load_state_dict(enabled.state_dict())
    x = torch.randn(4, 3, requires_grad=True)
    expected = disabled(x)
    actual = enabled(x)
    assert torch.allclose(actual, expected)
    enabled.zero_grad(set_to_none=True)
    disabled.zero_grad(set_to_none=True)
    actual.sum().backward()
    expected.sum().backward()
    for enabled_param, disabled_param in zip(enabled.parameters(), disabled.parameters()):
        assert torch.equal(enabled_param.grad, disabled_param.grad)
    assert set(enabled.state_dict()) == state_before
    assert "linear-visual" in enabled.interpretability.source_registry
    assert enabled.interpretability.finalize("POST_RUN")


def test_cleanup_serialized_model_has_no_observable_run_state(tmp_path):
    """Published files survive cleanup, but a whole-model pickle does not."""
    cfg = _model_config(tmp_path)
    model = Net(cfg)
    model.eval()
    model.interpretability.set_context("EVAL")
    expected = model(torch.ones(2, 3))
    results = model.interpretability.end_scope()
    artifact = results[0]["rows"][0]["artifact"]
    result_path = model.interpretability.publisher.result_path("obs-rec")
    assert Path(artifact).is_file()
    assert result_path.is_file()

    model.cleanup_interpretability()
    assert model.interpretability.publisher.tables == {}
    assert model.interpretability.publisher._table_keys == {}
    assert Path(artifact).is_file()
    assert result_path.is_file()
    assert all(
        not state.rows and not state.tensors
        for observable in model.interpretability.observables
        for state in observable._states.values()
    )
    assert not any(getattr(module, "_observer", None) for module in model.modules())

    model_path = tmp_path / "model.pt"
    torch.save(model, model_path)
    loaded = torch.load(model_path, weights_only=False)
    actual = loaded(torch.ones(2, 3))
    assert torch.allclose(actual, expected)
    assert loaded.state_dict().keys() == model.state_dict().keys()
    assert loaded.interpretability.publisher.tables == {}
    assert loaded.interpretability.publisher._table_keys == {}
    assert loaded.interpretability.publisher.experiment is None
    assert loaded.interpretability.publisher.wandb is None
    assert all(
        not state.rows and not state.tensors
        for observable in loaded.interpretability.observables
        for state in observable._states.values()
    )
    assert not any(getattr(module, "_observer", None) for module in loaded.modules())


def test_compacted_sequential_input_public_output_is_observable(tmp_path):
    cfg = _model_config(tmp_path)
    OmegaConf.set_struct(cfg.interpretability.observables, False)
    cfg.interpretability.observables["obs-input"] = OmegaConf.create({
        "id": "obs-input",
        "pythonClassName": "interpretability.ActivationStatistics",
        "enabled": True,
        "executionModes": ["EVAL"],
        "supportedModes": ["EVAL"],
        "finalizePhase": "POST_EPOCH",
        "retentionScope": "EPOCH",
        "supportedRetentionScopes": ["EPOCH"],
        "storageStrategy": "STREAMING",
        "supportedStorageStrategies": ["STREAMING"],
        "inputs": [{"sourceNodeId": "input-visual", "sourcePoint": "out"}],
    })
    model = Net(cfg)
    model.eval()
    model.interpretability.set_context("EVAL", epoch=0)
    model(torch.ones(2, 3))
    assert any(row["observable_id"] == "obs-input" for row in model.interpretability.finalize("POST_EPOCH"))


def test_nested_subflow_module_and_input_outputs_are_observable(tmp_path):
    cfg = OmegaConf.create({
        "net": {
            "root": "root",
            "nodes": {
                "root": {"type": "module", "stereotype": "Input", "children": ["sf"]},
                "sf": {
                    "type": "subflow", "stereotype": "Subflow", "children": [],
                    "_target_": "ops.Subflow", "_recursive_": False, "entry_node": "nested-input",
                    "internal_nodes": {
                        "nested-input": {"type": "module", "stereotype": "Input", "children": ["nested-linear"]},
                        "nested-linear": {
                            "type": "module", "stereotype": "Linear", "children": [],
                            "_target_": "torch.nn.Linear", "in_features": 3, "out_features": 2,
                        },
                    },
                },
            },
            "lossNode": {"stereotype": "MSELoss", "_target_": "torch.nn.MSELoss", "taskType": "regression"},
        },
        "interpretability": {
            "enabled": True,
            "run_root": str(tmp_path),
            "observables": {
                "nested-input": {**_recorder_config("nested-input")["observables"]["obs"], "id": "nested-input"},
                "nested-linear": {**_recorder_config("nested-linear")["observables"]["obs"], "id": "nested-linear"},
            },
        },
        "optimizer": {"_target_": "torch.optim.Adam", "lr": 0.001},
    })
    model = Net(cfg)
    model.eval()
    model.interpretability.set_context("EVAL")
    model(torch.ones(1, 3))
    result = model.interpretability.finalize("POST_RUN")
    assert {row["observable_id"] for item in result for row in item["rows"]} == {"nested-input", "nested-linear"}


def test_mode_gating_and_statistics_finalize(tmp_path):
    cfg = _model_config(tmp_path)
    model = Net(cfg)
    model.train()
    model.interpretability.set_context("TRAIN")
    model(torch.ones(2, 3))
    assert model.interpretability.finalize("POST_EPOCH") == []
    model.eval()
    model.interpretability.set_context("EVAL", epoch=2)
    model(torch.ones(2, 3))
    results = model.interpretability.finalize("POST_EPOCH")
    assert results and results[0]["count"] == 4


def test_post_run_flushes_train_only_observable_after_mode_switch(tmp_path):
    """Finalization must inspect captured mode buckets, not current mode."""
    source = torch.nn.Identity()
    config = _recorder_config(
        "source", executionModes=["TRAIN"], supportedModes=["TRAIN"],
    )
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    manager.begin_scope("fit", "TRAIN")
    source(torch.tensor([[1.0]]))
    manager.set_context("EVAL", epoch=3, global_step=12, batch_index=0)

    results = manager.end_scope()

    assert results
    assert results[0]["rows"][0]["execution_mode"] == "TRAIN"
    assert manager.publisher.tables["obs"][0]["execution_mode"] == "TRAIN"


def test_statistics_pending_rows_keep_capture_context_after_mode_switch(tmp_path):
    source = torch.nn.Identity()
    config = _recorder_config(
        "source", pythonClassName="interpretability.ActivationStatistics",
        executionModes=["TRAIN", "EVAL"], supportedModes=["TRAIN", "EVAL"],
        finalizePhase="POST_RUN", retentionScope="EPOCH",
        supportedRetentionScopes=["EPOCH", "RUN"], storageStrategy="STREAMING",
        supportedStorageStrategies=["STREAMING"],
    )
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    manager.begin_scope("fit", "TRAIN")
    manager.set_context("TRAIN", epoch=2, global_step=5, batch_index=4)
    source(torch.tensor([[1.0, 3.0]]))
    manager.finalize("POST_EPOCH")
    manager.set_context("EVAL", epoch=9, global_step=20, batch_index=1)

    results = manager.end_scope()

    train_row = next(row for row in manager.publisher.tables["obs"] if row["execution_mode"] == "TRAIN")
    assert train_row["epoch"] == 2
    assert train_row["global_step"] == 5
    assert train_row["batch_index"] == 4
    assert results


def test_lightning_fit_finalizes_train_only_recorder_after_validation(tmp_path):
    cfg = OmegaConf.create({
        "net": {
            "root": "input",
            "nodes": {
                "input": {"type": "module", "stereotype": "Input", "children": ["linear"]},
                "linear": {
                    "type": "module", "stereotype": "Linear", "children": [],
                    "layer": {"stereotype": "Linear", "_target_": "torch.nn.Linear", "in_features": 3, "out_features": 2},
                },
            },
            "lossNode": {"stereotype": "CrossEntropyLoss", "_target_": "torch.nn.CrossEntropyLoss", "taskType": "classification"},
            "num_classes": 2,
        },
        "interpretability": {"enabled": True, "run_root": str(tmp_path), "observables": {
            "train-only": {
                **_recorder_config("linear")["observables"]["obs"], "id": "train-only",
                "executionModes": ["TRAIN"], "supportedModes": ["TRAIN"],
            },
        }},
        "optimizer": {"_target_": "torch.optim.SGD", "lr": 0.01},
    })
    model = Net(cfg)
    train_loader = DataLoader(TensorDataset(torch.randn(2, 3), torch.tensor([0, 1])), batch_size=1)
    validation_loader = DataLoader(TensorDataset(torch.randn(1, 3), torch.tensor([0])), batch_size=1)
    trainer = lit.Trainer(
        logger=False, enable_progress_bar=False, max_epochs=1, limit_train_batches=1,
        limit_val_batches=1, default_root_dir=tmp_path, enable_checkpointing=False,
    )

    trainer.fit(model, train_loader, validation_loader)

    rows = model.interpretability.publisher.tables["train-only"]
    assert rows
    assert {row["execution_mode"] for row in rows} == {"TRAIN"}


def test_wandb_failure_keeps_local_result(tmp_path):
    experiment = Mock()
    experiment.log.side_effect = RuntimeError("offline")
    wandb = Mock()
    wandb.Table.return_value = object()
    publisher = ResultPublisher(str(tmp_path), experiment, wandb)
    publisher.publish("obs", "observable/obs", [{"value": 1}])
    assert publisher.result_path("obs").exists()
    experiment.log.assert_called_once()


def test_manager_validates_phase_and_hook_returns_none(tmp_path):
    publisher = ResultPublisher(str(tmp_path))
    manager = ObservableManager({"enabled": True, "observables": {}}, publisher=publisher)
    with pytest.raises(ValueError):
        manager.finalize("NOT_A_PHASE")
    assert manager.capture("missing", torch.ones(1)) is None


def _recorder_config(source: str, **overrides):
    config = {
        "enabled": True,
        "observables": {
            "obs": {
                "id": "obs",
                "pythonClassName": "interpretability.ActivationRecorder",
                "executionModes": ["TRAIN", "EVAL", "PREDICT"],
                "supportedModes": ["TRAIN", "EVAL", "PREDICT"],
                "finalizePhase": "POST_RUN",
                "retentionScope": "RUN",
                "supportedRetentionScopes": ["LAST", "BATCH", "EPOCH", "RUN"],
                "storageStrategy": "FULL",
                "supportedStorageStrategies": ["FULL", "SAMPLED"],
                "inputs": [{"sourceNodeId": source, "sourcePoint": "out"}],
                "max_samples": 128,
                "sample_every": 1,
            }
        },
    }
    config["observables"]["obs"].update(overrides)
    return config


def test_fit_test_predict_scopes_finalize_once_and_do_not_lose_later_captures(tmp_path):
    source = torch.nn.Identity()
    publisher = ResultPublisher(str(tmp_path))
    manager = ObservableManager(_recorder_config("source"), {"source": source}, publisher=publisher)
    manager.attach()
    for scope, mode, value in [("fit", "TRAIN", 1.0), ("test", "EVAL", 2.0), ("predict", "PREDICT", 3.0)]:
        manager.begin_scope(scope, mode)
        source(torch.tensor([[value]]))
        first = manager.end_scope()
        assert len(first) == 1
        assert manager.end_scope() == []
    rows = publisher.tables["obs"]
    assert [row["execution_mode"] for row in rows] == ["TRAIN", "EVAL", "PREDICT"]
    assert len(manager.observables[0]._states) == 1  # empty compatibility state only
    assert not manager.observables[0]._states["EVAL"].tensors


@pytest.mark.parametrize(
    ("retention", "storage", "finalize_phase"),
    [("RUN", "FULL", "POST_RUN"), ("BATCH", "SAMPLED", "POST_BATCH"), ("LAST", "SAMPLED", "POST_BATCH")],
)
def test_retention_and_storage_combinations_are_enforced(tmp_path, retention, storage, finalize_phase):
    source = torch.nn.Identity()
    config = _recorder_config(
        "source",
        retentionScope=retention,
        storageStrategy=storage,
        finalizePhase=finalize_phase,
        supportedStorageStrategies=["FULL", "SAMPLED"],
    )
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    manager.begin_scope("scope", "EVAL")
    source(torch.tensor([[1.0]]))
    source(torch.tensor([[2.0]]))
    result = manager.finalize(finalize_phase)
    assert result
    if retention == "BATCH":
        source(torch.tensor([[3.0]]))
        assert manager.finalize(finalize_phase) == []


@pytest.mark.parametrize(
    ("retention", "boundary", "finalize_phase"),
    [("BATCH", "POST_BATCH", "POST_RUN"), ("EPOCH", "POST_EPOCH", "POST_RUN")],
)
def test_recorder_pending_windows_survive_early_retention_boundaries(tmp_path, retention, boundary, finalize_phase):
    source = torch.nn.Identity()
    config = _recorder_config("source", retentionScope=retention, finalizePhase=finalize_phase)
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    manager.begin_scope("scope", "TRAIN")
    source(torch.tensor([[1.0]]))
    manager.finalize(boundary)
    source(torch.tensor([[2.0]]))
    manager.end_scope()
    assert [torch.load(row["artifact"], weights_only=True).item() for row in manager.publisher.tables["obs"]] == [1.0, 2.0]


@pytest.mark.parametrize(
    ("retention", "boundary", "finalize_phase"),
    [("BATCH", "POST_BATCH", "POST_EPOCH"), ("EPOCH", "POST_EPOCH", "POST_RUN")],
)
def test_statistics_pending_windows_survive_early_retention_boundaries(tmp_path, retention, boundary, finalize_phase):
    source = torch.nn.Identity()
    config = _recorder_config(
        "source", pythonClassName="interpretability.ActivationStatistics",
        retentionScope=retention, finalizePhase=finalize_phase,
        supportedRetentionScopes=["BATCH", "EPOCH", "RUN"],
        storageStrategy="STREAMING", supportedStorageStrategies=["STREAMING"],
    )
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    manager.begin_scope("scope", "TRAIN")
    source(torch.tensor([[1.0, 3.0]]))
    manager.finalize(boundary)
    source(torch.tensor([[5.0, 7.0]]))
    manager.end_scope() if finalize_phase == "POST_RUN" else manager.finalize(finalize_phase)
    assert [row["mean"] for row in manager.publisher.tables["obs"]] == [2.0, 6.0]


def test_mode_state_isolation_for_streaming_statistics(tmp_path):
    source = torch.nn.Identity()
    config = _recorder_config(
        "source",
        pythonClassName="interpretability.ActivationStatistics",
        finalizePhase="POST_EPOCH",
        retentionScope="EPOCH",
        supportedRetentionScopes=["BATCH", "EPOCH", "RUN"],
        storageStrategy="STREAMING",
        supportedStorageStrategies=["STREAMING"],
    )
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    manager.begin_scope("fit", "TRAIN")
    source(torch.tensor([[1.0, 3.0]]))
    manager.set_context("EVAL", epoch=0)
    source(torch.tensor([[10.0, 20.0]]))
    results = manager.finalize("POST_EPOCH")
    assert {row["execution_mode"] for row in results} == {"TRAIN", "EVAL"}
    assert {row["mean"] for row in results} == {2.0, 15.0}


def test_recorded_artifacts_are_unique_and_reloadable(tmp_path):
    source = torch.nn.Identity()
    manager = ObservableManager(_recorder_config("source"), {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    artifacts = []
    for scope in ("one", "two"):
        manager.begin_scope(scope, "EVAL")
        source(torch.tensor([[float(len(artifacts) + 1)]]))
        result = manager.end_scope()[0]
        artifacts.extend(row["artifact"] for row in result["rows"])
    assert len(set(artifacts)) == len(artifacts)
    assert [torch.load(path, weights_only=True).item() for path in artifacts] == [1.0, 2.0]


def test_independent_runs_with_same_observable_id_keep_metadata_and_artifacts(tmp_path):
    """A shared configured root must not make direct runs overwrite each other."""
    source_one = torch.nn.Identity()
    source_two = torch.nn.Identity()
    manager_one = ObservableManager(
        _recorder_config("source"), {"source": source_one}, publisher=ResultPublisher(str(tmp_path))
    )
    manager_two = ObservableManager(
        _recorder_config("source"), {"source": source_two}, publisher=ResultPublisher(str(tmp_path))
    )
    for manager, source, value in ((manager_one, source_one, 1.0), (manager_two, source_two, 2.0)):
        manager.attach()
        manager.begin_scope("direct", "EVAL")
        source(torch.tensor([[value]]))
        assert manager.end_scope()

    publisher_one = manager_one.publisher
    publisher_two = manager_two.publisher
    assert publisher_one.run_dir != publisher_two.run_dir
    assert publisher_one.result_path("obs").is_file()
    assert publisher_two.result_path("obs").is_file()
    row_one = publisher_one.tables["obs"][0]
    row_two = publisher_two.tables["obs"][0]
    assert row_one["artifact"] != row_two["artifact"]
    assert Path(row_one["artifact"]).is_file()
    assert Path(row_two["artifact"]).is_file()
    assert row_one["observable_id"] == row_two["observable_id"] == "obs"
    assert row_one["sources"] == row_two["sources"]


def test_bad_observable_configuration_isolated_with_warning(tmp_path):
    config = _recorder_config("missing", max_samples="not-a-number", move_to_cpu="sometimes")
    with pytest.warns(RuntimeWarning, match="Skipping Observable"):
        manager = ObservableManager(config, {}, publisher=ResultPublisher(str(tmp_path)))
    assert manager.observables == []


def test_manual_input_and_fork_sources_are_dispatchable(tmp_path):
    config = _recorder_config("input")
    config["observables"]["fork"] = dict(config["observables"]["obs"], id="fork", inputs=[{"sourceNodeId": "fork", "sourcePoint": "out"}])
    manager = ObservableManager(config, {}, manual_sources={"input", "fork"}, publisher=ResultPublisher(str(tmp_path)))
    manager.begin_scope("scope", "EVAL")
    manager.capture("input", torch.ones(1))
    manager.capture("fork", torch.ones(1) * 2)
    assert len(manager.end_scope()) == 2


def test_wandb_table_names_are_unique_per_instance(tmp_path):
    module = torch.nn.Identity()
    config = _recorder_config("source")
    duplicate = dict(config["observables"]["obs"], id="second", wandb_table_name="same")
    config["observables"]["obs"]["wandb_table_name"] = "same"
    config["observables"]["second"] = duplicate
    experiment = Mock()
    wandb = Mock()
    publisher = ResultPublisher(str(tmp_path), experiment, wandb)
    manager = ObservableManager(config, {"source": module}, publisher=publisher)
    manager.attach()
    manager.begin_scope("scope", "EVAL")
    module(torch.ones(1))
    manager.end_scope()
    keys = [call.args[0].keys() for call in experiment.log.call_args_list]
    assert {next(iter(key_set)) for key_set in keys} == {"observable/obs/same", "observable/second/same"}


def _repeat_internal_nodes():
    return {
        "repeat-input": {"type": "module", "stereotype": "Input", "children": ["repeat-linear"]},
        "repeat-linear": {
            "type": "module", "stereotype": "Linear", "children": [],
            "_target_": "torch.nn.Linear", "in_features": 2, "out_features": 2,
        },
    }


@pytest.mark.parametrize("op_factory", [lambda: Repeat("repeat-input", _repeat_internal_nodes(), iterations=3),
                                          lambda: HorizontalRepeat("repeat-input", _repeat_internal_nodes(), n=1),
                                          lambda: HorizontalRepeat("repeat-input", _repeat_internal_nodes(), n=2)])
def test_repeat_operations_expose_every_head_source_and_preserve_output(tmp_path, op_factory):
    torch.manual_seed(11)
    operation = op_factory()
    disabled = op_factory()
    disabled.load_state_dict(operation.state_dict())
    source_modules = []
    for submodule in operation.modules():
        internal = getattr(submodule, "module_dict", None)
        if internal is not None and "repeat-linear" in internal:
            source_modules.append(internal["repeat-linear"])
    config = _recorder_config("repeat-linear")
    config["observables"]["input"] = dict(config["observables"]["obs"], id="input", inputs=[{"sourceNodeId": "repeat-input", "sourcePoint": "out"}])
    manager = ObservableManager(config, {"repeat-linear": source_modules}, manual_sources={"repeat-input"}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()
    operation.set_observer(manager.capture)
    manager.begin_scope("scope", "EVAL")
    x = torch.randn(3, 2)
    enabled_output = operation(x)
    disabled_output = disabled(x)
    manager.end_scope()
    assert torch.allclose(enabled_output, disabled_output)
    rows = manager.publisher.tables
    expected_heads = 3 if isinstance(operation, Repeat) else operation.n
    assert len(rows["obs"]) == expected_heads
    assert len(rows["input"]) == expected_heads


def test_post_step_is_emitted_only_for_real_optimizer_updates_with_accumulation(tmp_path):
    cfg = OmegaConf.create({
        "net": {
            "root": "input",
            "nodes": {
                "input": {"type": "module", "stereotype": "Input", "children": ["linear"]},
                "linear": {
                    "type": "module", "stereotype": "Linear", "children": [],
                    "layer": {"stereotype": "Linear", "_target_": "torch.nn.Linear", "in_features": 3, "out_features": 2},
                },
            },
            "lossNode": {"stereotype": "CrossEntropyLoss", "_target_": "torch.nn.CrossEntropyLoss", "taskType": "classification"},
            "num_classes": 2,
        },
        "interpretability": {"enabled": True, "run_root": str(tmp_path), "observables": {
            "steps": {
                **_recorder_config("linear")["observables"]["obs"],
                "id": "steps", "executionModes": ["TRAIN"], "supportedModes": ["TRAIN"],
                "finalizePhase": "POST_STEP", "retentionScope": "BATCH",
                "supportedRetentionScopes": ["BATCH"], "storageStrategy": "SAMPLED",
            },
        }},
        "optimizer": {"_target_": "torch.optim.SGD", "lr": 0.01},
    })
    model = Net(cfg)
    loader = DataLoader(TensorDataset(torch.randn(3, 3), torch.tensor([0, 1, 0])), batch_size=1)
    trainer = lit.Trainer(
        logger=False, enable_progress_bar=False, max_epochs=1,
        limit_train_batches=3, limit_val_batches=0, accumulate_grad_batches=2,
        default_root_dir=tmp_path, enable_checkpointing=False,
    )
    trainer.fit(model, loader)
    # Three batches with accumulation of two cause two optimizer updates (the
    # final partial accumulation is flushed by Lightning).
    assert len({row["global_step"] for row in model.interpretability.publisher.tables["steps"]}) == 2


def test_lightning_fit_then_test_finalize_post_run_per_scope(tmp_path):
    cfg = OmegaConf.create({
        "net": {
            "root": "input",
            "nodes": {
                "input": {"type": "module", "stereotype": "Input", "children": ["linear"]},
                "linear": {
                    "type": "module", "stereotype": "Linear", "children": [],
                    "layer": {"stereotype": "Linear", "_target_": "torch.nn.Linear", "in_features": 3, "out_features": 2},
                },
            },
            "lossNode": {"stereotype": "CrossEntropyLoss", "_target_": "torch.nn.CrossEntropyLoss", "taskType": "classification"},
            "num_classes": 2,
        },
        "interpretability": {"enabled": True, "run_root": str(tmp_path), "observables": {
            "runs": {
                **_recorder_config("linear")["observables"]["obs"], "id": "runs",
            },
        }},
        "optimizer": {"_target_": "torch.optim.SGD", "lr": 0.01},
    })
    model = Net(cfg)
    loader = DataLoader(TensorDataset(torch.randn(2, 3), torch.tensor([0, 1])), batch_size=1)
    trainer = lit.Trainer(
        logger=False, enable_progress_bar=False, max_epochs=1,
        limit_train_batches=1, limit_val_batches=0, limit_test_batches=1,
        default_root_dir=tmp_path, enable_checkpointing=False,
    )
    trainer.fit(model, loader)
    trainer.test(model, loader)
    rows = model.interpretability.publisher.tables["runs"]
    assert [row["execution_mode"] for row in rows] == ["TRAIN", "EVAL"]
    assert model.interpretability._scope_finalized is True


def test_direct_predict_helper_routes_batch_epoch_and_run_phases(tmp_path):
    source = torch.nn.Identity()
    base = _recorder_config("source")["observables"]["obs"]
    config = {"enabled": True, "observables": {
        "batch": {**base, "id": "batch", "executionModes": ["PREDICT"], "supportedModes": ["PREDICT"],
                   "finalizePhase": "POST_BATCH", "retentionScope": "BATCH", "supportedRetentionScopes": ["BATCH"]},
        "epoch": {**base, "id": "epoch", "executionModes": ["PREDICT"], "supportedModes": ["PREDICT"],
                   "finalizePhase": "POST_EPOCH", "retentionScope": "EPOCH", "supportedRetentionScopes": ["EPOCH"]},
        "run": {**base, "id": "run", "executionModes": ["PREDICT"], "supportedModes": ["PREDICT"],
                "finalizePhase": "POST_RUN", "retentionScope": "RUN", "supportedRetentionScopes": ["RUN"]},
    }}
    manager = ObservableManager(config, {"source": source}, publisher=ResultPublisher(str(tmp_path)))
    manager.attach()

    class PredictModel(torch.nn.Module):
        def __init__(self, wrapped, observation_manager):
            super().__init__()
            self.wrapped = wrapped
            self.interpretability = observation_manager

        def forward(self, x):
            return self.wrapped(x)

    model = PredictModel(source, manager)
    manager.begin_scope("predict", "PREDICT")
    list(iter_predict_batches(model, DataLoader(TensorDataset(torch.ones(2, 1), torch.zeros(2, dtype=torch.long)), batch_size=1), "cpu"))
    manager.end_scope()
    assert len(manager.publisher.tables["batch"]) == 2
    assert len(manager.publisher.tables["epoch"]) == 2
    assert len(manager.publisher.tables["run"]) == 2
