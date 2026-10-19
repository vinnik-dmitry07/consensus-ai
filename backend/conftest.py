"""Keep roster checks offline: the selected models count as listed."""

import pytest


@pytest.fixture(autouse=True)
def free_tier_test_key(monkeypatch):
    monkeypatch.setattr(
        'backend.openrouter.FREE_TIER_API_KEY',
        'sk-free-test',
    )


@pytest.fixture(autouse=True)
def servable_catalogue(monkeypatch):
    from backend.roster import clear_blocked_ids, reset_free_queue_for_tests

    clear_blocked_ids()
    reset_free_queue_for_tests()

    async def fake_pricing():
        from backend.roster import _selected_catalogue_ids

        return {model_id: {} for model_id in _selected_catalogue_ids()}

    monkeypatch.setattr('backend.openrouter.get_models_pricing', fake_pricing)
